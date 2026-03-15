import { 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle,
  StringSelectMenuBuilder,
  Message,
  TextBasedChannel,
  EmbedBuilder,
  ComponentType
} from 'discord.js';
import type { QuestionRequest, TodoItem } from '../types/index.js';
import * as dataStore from './dataStore.js';
import * as sessionManager from './sessionManager.js';
import { getServeHostname } from './configStore.js';
import * as serveManager from './serveManager.js';
import * as worktreeManager from './worktreeManager.js';
import { SSEClient } from './sseClient.js';
import { formatOutput, formatOutputForMobile, buildContextHeader } from '../utils/messageFormatter.js';
import { processNextInQueue } from './queueManager.js';

export async function runPrompt(
  channel: TextBasedChannel, 
  threadId: string, 
  prompt: string, 
  parentChannelId: string
): Promise<void> {
  const projectPath = dataStore.getChannelProjectPath(parentChannelId);
  if (!projectPath) {
    await (channel as any).send('❌ No project bound to parent channel.');
    return;
  }
  
  let worktreeMapping = dataStore.getWorktreeMapping(threadId);
  
  // Auto-create worktree if enabled and no mapping exists for this thread
  if (!worktreeMapping) {
    const projectAlias = dataStore.getChannelBinding(parentChannelId);
    if (projectAlias && dataStore.getProjectAutoWorktree(projectAlias)) {
      try {
        const branchName = worktreeManager.sanitizeBranchName(
          `auto/${threadId.slice(0, 8)}-${Date.now()}`
        );
        const worktreePath = await worktreeManager.createWorktree(projectPath, branchName);
        
        const newMapping = {
          threadId,
          branchName,
          worktreePath,
          projectPath,
          description: prompt.slice(0, 50) + (prompt.length > 50 ? '...' : ''),
          createdAt: Date.now()
        };
        dataStore.setWorktreeMapping(newMapping);
        worktreeMapping = newMapping;
        
        const embed = new EmbedBuilder()
          .setTitle(`🌳 Auto-Worktree: ${branchName}`)
          .setDescription('Automatically created for this session')
          .addFields(
            { name: 'Branch', value: branchName, inline: true },
            { name: 'Path', value: worktreePath, inline: true }
          )
          .setColor(0x2ecc71);
        
        const worktreeButtons = new ActionRowBuilder<ButtonBuilder>()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`delete_${threadId}`)
              .setLabel('Delete')
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId(`pr_${threadId}`)
              .setLabel('Create PR')
              .setStyle(ButtonStyle.Primary)
          );
        
        await (channel as any).send({ embeds: [embed], components: [worktreeButtons] });
      } catch (error) {
        console.error('Auto-worktree creation failed:', error);
      }
    }
  }
  
  const effectivePath = worktreeMapping?.worktreePath ?? projectPath;
  const preferredModel = dataStore.getChannelModel(parentChannelId);
  const modelDisplay = preferredModel ? `${preferredModel}` : 'default';
  
  const branchName = worktreeMapping?.branchName ?? await worktreeManager.getCurrentBranch(effectivePath) ?? 'main';
  const contextHeader = buildContextHeader(branchName, modelDisplay);
  
  const buttons = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`interrupt_${threadId}`)
        .setLabel('⏸️ Interrupt')
        .setStyle(ButtonStyle.Secondary)
    );
  
  let streamMessage: Message;
  try {
    streamMessage = await (channel as any).send({
      content: `${contextHeader}\n📌 **Prompt**: ${prompt}\n\n🚀 Starting OpenCode server...`,
      components: [buttons]
    });
  } catch {
    return;
  }
  
  let port: number;
  let sessionId: string;
  let updateInterval: NodeJS.Timeout | null = null;
  let accumulatedText = '';
  let lastContent = '';
  let tick = 0;
  let promptSent = false;
  let hasSessionError = false;
  let todoMessage: Message | null = null;
  let lastTodoContent = '';
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  
  const updateStreamMessage = async (content: string, components: ActionRowBuilder<ButtonBuilder>[]) => {
    try {
      await streamMessage.edit({ content, components });
    } catch {
    }
  };
  
  try {
    port = await serveManager.spawnServe(effectivePath, preferredModel);
    
    await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n⏳ Waiting for OpenCode server...`, [buttons]);
    await serveManager.waitForReady(port, 30000, effectivePath, preferredModel);
    
    const settings = dataStore.getQueueSettings(threadId);
    
    // If fresh context is enabled, we always clear the session before starting
    if (settings.freshContext) {
      console.log(`[session] freshContext enabled for thread ${threadId}, clearing session`);
      sessionManager.clearSessionForThread(threadId);
    }

    const existingSession = sessionManager.getSessionForThread(threadId);
    console.log(`[session] thread=${threadId} existing=${existingSession?.sessionId ?? 'none'} existingPath=${existingSession?.projectPath ?? 'none'} effectivePath=${effectivePath}`);
    if (existingSession && existingSession.projectPath === effectivePath) {
      const isValid = await sessionManager.validateSession(port, existingSession.sessionId);
      console.log(`[session] validateSession(${existingSession.sessionId}) = ${isValid}`);
      if (isValid) {
        sessionId = existingSession.sessionId;
        sessionManager.updateSessionLastUsed(threadId);
        console.log(`[session] REUSING session ${sessionId} for thread ${threadId}`);
      } else {
        sessionId = await sessionManager.createSession(port);
        sessionManager.setSessionForThread(threadId, sessionId, effectivePath, port);
        console.log(`[session] CREATED new session ${sessionId} (old invalid) for thread ${threadId}`);
      }
    } else {
      sessionId = await sessionManager.createSession(port);
      sessionManager.setSessionForThread(threadId, sessionId, effectivePath, port);
      console.log(`[session] CREATED new session ${sessionId} (no existing / path mismatch) for thread ${threadId}`);
    }
    
    const sseClient = new SSEClient();
    const sseHostname = getServeHostname();
    const sseHost = sseHostname === '0.0.0.0' ? '127.0.0.1' : sseHostname;
    sseClient.connect(`http://${sseHost}:${port}`);
    sessionManager.setSseClient(threadId, sseClient);
    
    sseClient.onPartUpdated((part) => {
      if (part.sessionID !== sessionId) return;
      // Only keep the latest text — intermediate "thinking" parts between tool
      // calls are noise. The final text part is the actual response.
      accumulatedText = part.text;
    });
    
    sseClient.onSessionIdle((idleSessionId) => {
      if (idleSessionId !== sessionId) return;
      if (!promptSent) return;
      
      if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
      }
      
      (async () => {
        try {
          if (hasSessionError) {
            sseClient.disconnect();
            sessionManager.clearSseClient(threadId);
            return;
          }

          const disabledButtons = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(`interrupt_${threadId}`)
                .setLabel('⏸️ Interrupt')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
            );

          // If SSE didn't capture any text, try fetching the last message via API
          if (!accumulatedText.trim()) {
            try {
              const sseHostname = getServeHostname();
              const sseHost = sseHostname === '0.0.0.0' ? '127.0.0.1' : sseHostname;
              const msgResp = await fetch(`http://${sseHost}:${port}/session/${sessionId}/message`);
              if (msgResp.ok) {
                const messages = await msgResp.json() as Array<{ role?: string; parts?: Array<{ type?: string; text?: string }> }>;
                // Find last assistant message with a text part
                for (let i = messages.length - 1; i >= 0; i--) {
                  const msg = messages[i];
                  if (msg.role === 'assistant') {
                    const textPart = msg.parts?.find((p: { type?: string }) => p.type === 'text' && (p as any).text?.trim());
                    if (textPart) {
                      accumulatedText = (textPart as any).text;
                      break;
                    }
                  }
                }
              }
            } catch {
              // API fallback failed, continue with empty
            }
          }

          if (!accumulatedText.trim()) {
            await updateStreamMessage(
              `${contextHeader}\n📌 **Prompt**: ${prompt}\n\n⚠️ No output received — the model may have encountered an issue.`,
              [disabledButtons]
            );
            await (channel as any).send({ content: '⚠️ Done (no output received)' });
          } else {
            const result = formatOutputForMobile(accumulatedText);
            
            await updateStreamMessage(
              `${contextHeader}\n📌 **Prompt**: ${prompt}\n\n${result.chunks[0]}`,
              [disabledButtons]
            );
            
            for (let i = 1; i < result.chunks.length; i++) {
              await (channel as any).send({ content: result.chunks[i] });
            }
            
            await (channel as any).send({ content: '✅ Done' });
          }
          
          sseClient.disconnect();
          sessionManager.clearSseClient(threadId);
          
          await processNextInQueue(channel, threadId, parentChannelId);
        } catch (error) {
          console.error('Error in onSessionIdle:', error);
        }
      })();
    });
    
    sseClient.onSessionError((errorSessionId, errorInfo) => {
      if (errorSessionId !== sessionId) return;
      if (!promptSent) return;
      
      hasSessionError = true;
      
      if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
      }
      
      (async () => {
        try {
          const errorMsg = errorInfo.data?.message || errorInfo.name || 'Unknown error';
          const disabledButtons = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(`interrupt_${threadId}`)
                .setLabel('⏸️ Interrupt')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
            );
          
          await updateStreamMessage(
            `${contextHeader}\n📌 **Prompt**: ${prompt}\n\n❌ **Error**: ${errorMsg}`,
            [disabledButtons]
          );
          
          sseClient.disconnect();
          sessionManager.clearSseClient(threadId);
          
          const settings = dataStore.getQueueSettings(threadId);
          if (settings.continueOnFailure) {
            await processNextInQueue(channel, threadId, parentChannelId);
          } else {
            dataStore.clearQueue(threadId);
            await (channel as any).send('❌ Execution failed. Queue cleared. Use `/queue settings` to change this behavior.');
          }
        } catch (error) {
          console.error('Error in onSessionError:', error);
        }
      })();
    });
    
    sseClient.onTodoUpdated((todoSessionId: string, todos: TodoItem[]) => {
      if (todoSessionId !== sessionId) return;
      
      const statusEmoji: Record<string, string> = {
        completed: '✅',
        in_progress: '🔄',
        pending: '⬜',
        cancelled: '❌',
      };
      
      const priorityLabel: Record<string, string> = {
        high: '🔴',
        medium: '🟡',
        low: '🟢',
      };
      
      const lines = todos.map((t) => {
        const status = statusEmoji[t.status] || '⬜';
        const priority = priorityLabel[t.priority] || '';
        return `${status} ${priority} ${t.content}`;
      });
      
      const completed = todos.filter((t) => t.status === 'completed').length;
      const total = todos.length;
      const content = `📋 **Tasks** (${completed}/${total})\n${lines.join('\n')}`;
      
      // Skip update if content hasn't changed
      if (content === lastTodoContent) return;
      lastTodoContent = content;
      
      (async () => {
        try {
          if (todoMessage) {
            await todoMessage.edit({ content });
          } else {
            todoMessage = await (channel as any).send({ content });
          }
        } catch {
          // Message may have been deleted
          todoMessage = null;
        }
      })();
    });
    
    sseClient.onQuestionAsked((question: QuestionRequest) => {
      if (question.sessionID !== sessionId) return;
      
      (async () => {
        try {
          for (let qi = 0; qi < question.questions.length; qi++) {
            const q = question.questions[qi];
            
            if (q.options.length > 0) {
              // Render as Discord select menu
              const options = q.options.map((opt, i) => ({
                label: opt.label.slice(0, 100),
                description: opt.description?.slice(0, 100) || undefined,
                value: String(i),
              }));
              
              // Add custom answer option if allowed (default: true)
              if (q.custom !== false) {
                options.push({
                  label: '✏️ Type custom answer',
                  description: 'Provide your own response',
                  value: '__custom__',
                });
              }
              
              const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`question_${question.id}_${qi}`)
                .setPlaceholder(q.header || 'Select an option')
                .setMinValues(1)
                .setMaxValues(q.multiple ? Math.min(options.length, 25) : 1)
                .addOptions(options.slice(0, 25));
              
              const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
              
              const skipButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId(`question_skip_${question.id}`)
                  .setLabel('Skip / Dismiss')
                  .setStyle(ButtonStyle.Secondary)
              );
              
              const questionMsg = await (channel as any).send({
                content: `❓ **${q.header}**\n${q.question}`,
                components: [row, skipButton],
              });
              
              // Wait for user interaction (5 minute timeout)
              try {
                const collected = await questionMsg.awaitMessageComponent({
                  time: 300_000,
                });
                
                if (collected.customId.startsWith('question_skip_')) {
                  await collected.update({ content: `❓ **${q.header}** — *Dismissed*`, components: [] });
                  await sessionManager.rejectQuestion(port, question.id);
                  return;
                }
                
                if (collected.isStringSelectMenu()) {
                  const selectedValues = collected.values;
                  
                  if (selectedValues.includes('__custom__')) {
                    await collected.update({ content: `❓ **${q.header}**\n\nType your answer below:`, components: [] });
                    
                    const msgCollected = await (channel as any).awaitMessages({
                      max: 1,
                      time: 300_000,
                      filter: (m: Message) => !m.author.bot,
                    });
                    
                    const userReply = msgCollected.first()?.content;
                    if (userReply) {
                      const answers: string[][] = question.questions.map(() => []);
                      answers[qi] = [userReply];
                      await sessionManager.replyToQuestion(port, question.id, answers);
                      await (channel as any).send(`✅ Answered: "${userReply.slice(0, 100)}"`);
                    } else {
                      await sessionManager.rejectQuestion(port, question.id);
                      await (channel as any).send('⏭️ Question timed out — dismissed.');
                    }
                  } else {
                    const selectedLabels = selectedValues.map((v: string) => q.options[parseInt(v)].label);
                    const answers: string[][] = question.questions.map(() => []);
                    answers[qi] = selectedLabels;
                    
                    await collected.update({
                      content: `❓ **${q.header}** — Selected: ${selectedLabels.join(', ')}`,
                      components: [],
                    });
                    
                    await sessionManager.replyToQuestion(port, question.id, answers);
                  }
                }
              } catch {
                // Timeout — dismiss the question
                try {
                  await questionMsg.edit({ content: `❓ **${q.header}** — *Timed out*`, components: [] });
                } catch {}
                await sessionManager.rejectQuestion(port, question.id);
              }
            } else {
              // No options — free text question
              await (channel as any).send(`❓ **${q.header}**\n${q.question}\n\n*Type your answer below:*`);
              
              try {
                const msgCollected = await (channel as any).awaitMessages({
                  max: 1,
                  time: 300_000,
                  filter: (m: Message) => !m.author.bot,
                });
                
                const userReply = msgCollected.first()?.content;
                if (userReply) {
                  const answers: string[][] = question.questions.map(() => []);
                  answers[qi] = [userReply];
                  await sessionManager.replyToQuestion(port, question.id, answers);
                } else {
                  await sessionManager.rejectQuestion(port, question.id);
                }
              } catch {
                await sessionManager.rejectQuestion(port, question.id);
              }
            }
          }
        } catch (error) {
          console.error('Error handling question:', error);
          try {
            await sessionManager.rejectQuestion(port, question.id);
          } catch {}
        }
      })();
    });
    
    sseClient.onError((error) => {
      if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
      }
      
      (async () => {
        try {
          await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n❌ Connection error: ${error.message}`, []);
          
          sseClient.disconnect();
          sessionManager.clearSseClient(threadId);
          
          const settings = dataStore.getQueueSettings(threadId);
          if (settings.continueOnFailure) {
            await processNextInQueue(channel, threadId, parentChannelId);
          } else {
            dataStore.clearQueue(threadId);
            await (channel as any).send('❌ Execution failed. Queue cleared. Use `/queue settings` to change this behavior.');
          }
        } catch {
        }
      })();
    });
    
    updateInterval = setInterval(async () => {
      tick++;
      try {
        const formatted = formatOutput(accumulatedText);
        const spinnerChar = spinner[tick % spinner.length];
        const newContent = formatted || 'Processing...';
        
        if (newContent !== lastContent || tick % 2 === 0) {
          lastContent = newContent;
          await updateStreamMessage(
            `${contextHeader}\n📌 **Prompt**: ${prompt}\n\n${spinnerChar} **Running...**\n${newContent}`,
            [buttons]
          );
        }
      } catch {
      }
    }, 1000);
    
    await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n📝 Sending prompt...`, [buttons]);
    await sessionManager.sendPrompt(port, sessionId, prompt, preferredModel);
    promptSent = true;
    
  } catch (error) {
    if (updateInterval) {
      clearInterval(updateInterval);
    }
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n❌ OpenCode execution failed: ${errorMessage}`, []);
    
    const client = sessionManager.getSseClient(threadId);
    if (client) {
      client.disconnect();
      sessionManager.clearSseClient(threadId);
    }
    
    const settings = dataStore.getQueueSettings(threadId);
    if (settings.continueOnFailure) {
      await processNextInQueue(channel, threadId, parentChannelId);
    } else {
      dataStore.clearQueue(threadId);
      await (channel as any).send('❌ Execution failed. Queue cleared.');
    }
  }
}
