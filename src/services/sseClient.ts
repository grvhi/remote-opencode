import { EventSource } from 'eventsource';
import type { TextPart, SSEEvent, SessionErrorInfo, QuestionRequest, TodoItem, PermissionRequest } from '../types/index.js';

type PartUpdatedCallback = (part: TextPart) => void;
type SessionIdleCallback = (sessionId: string) => void;
type SessionErrorCallback = (sessionId: string, error: SessionErrorInfo) => void;
type QuestionAskedCallback = (question: QuestionRequest) => void;
type TodoUpdatedCallback = (sessionId: string, todos: TodoItem[]) => void;
type PermissionUpdatedCallback = (permission: PermissionRequest) => void;
type ErrorCallback = (error: Error) => void;

export class SSEClient {
  private eventSource: EventSource | null = null;
  private partUpdatedCallbacks: PartUpdatedCallback[] = [];
  private sessionIdleCallbacks: SessionIdleCallback[] = [];
  private sessionErrorCallbacks: SessionErrorCallback[] = [];
  private questionAskedCallbacks: QuestionAskedCallback[] = [];
  private todoUpdatedCallbacks: TodoUpdatedCallback[] = [];
  private permissionUpdatedCallbacks: PermissionUpdatedCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];

  connect(baseUrl: string): void {
    const url = `${baseUrl}/event`;
    this.eventSource = new EventSource(url);

    this.eventSource.addEventListener('message', (event: MessageEvent) => {
      try {
        const data: SSEEvent = JSON.parse(event.data);
        this.handleMessage(data);
      } catch (error) {
        this.handleError(new Error(`Failed to parse SSE event: ${error}`));
      }
    });

    this.eventSource.addEventListener('error', (error: Event) => {
      this.handleError(error instanceof Error ? error : new Error('SSE connection error'));
    });
  }

  onPartUpdated(callback: PartUpdatedCallback): void {
    this.partUpdatedCallbacks.push(callback);
  }

  onSessionIdle(callback: SessionIdleCallback): void {
    this.sessionIdleCallbacks.push(callback);
  }

  onSessionError(callback: SessionErrorCallback): void {
    this.sessionErrorCallbacks.push(callback);
  }

  onQuestionAsked(callback: QuestionAskedCallback): void {
    this.questionAskedCallbacks.push(callback);
  }

  onTodoUpdated(callback: TodoUpdatedCallback): void {
    this.todoUpdatedCallbacks.push(callback);
  }

  onPermissionUpdated(callback: PermissionUpdatedCallback): void {
    this.permissionUpdatedCallbacks.push(callback);
  }

  onError(callback: ErrorCallback): void {
    this.errorCallbacks.push(callback);
  }

  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  isConnected(): boolean {
    return this.eventSource !== null && this.eventSource.readyState === EventSource.OPEN;
  }

  private handleMessage(event: SSEEvent): void {
    // Log non-routine events for debugging
    if (!['message.part.updated', 'message.part.delta', 'message.updated', 'session.updated', 
          'session.status', 'session.diff', 'server.connected', 'server.heartbeat',
          'message.part.removed'].includes(event.type)) {
      console.log(`[sse] Event: ${event.type} | props: ${JSON.stringify(event.properties).slice(0, 200)}`);
    }
    if (event.type === 'message.part.updated') {
      const part = (event.properties as any).part;
      if (part && part.type === 'text') {
        const textPart: TextPart = {
          id: part.id,
          sessionID: part.sessionID,
          messageID: part.messageID,
          text: part.text,
        };
        this.partUpdatedCallbacks.forEach((cb) => cb(textPart));
      }
    } else if (event.type === 'session.idle') {
      const sessionID = (event.properties as any).sessionID;
      if (sessionID) {
        this.sessionIdleCallbacks.forEach((cb) => cb(sessionID));
      }
    } else if (event.type === 'session.error') {
      const sessionID = (event.properties as any).sessionID;
      const error = (event.properties as any).error as SessionErrorInfo | undefined;
      if (sessionID && error) {
        this.sessionErrorCallbacks.forEach((cb) => cb(sessionID, error));
      }
    } else if (event.type === 'todo.updated') {
      const props = event.properties as any;
      if (props && props.sessionID && props.todos) {
        this.todoUpdatedCallbacks.forEach((cb) => cb(props.sessionID, props.todos));
      }
    } else if (event.type === 'permission.updated' || event.type === 'permission.asked') {
      const props = event.properties as any;
      if (props && props.id && props.sessionID) {
        const permission: PermissionRequest = {
          id: props.id,
          type: props.permission || props.type || 'unknown',
          pattern: props.patterns || props.pattern,
          sessionID: props.sessionID,
          messageID: props.messageID || '',
          callID: props.callID,
          title: props.title || `Permission: ${props.permission || props.type || 'unknown'}`,
          metadata: props.metadata || {},
          time: props.time || { created: Date.now() },
        };
        this.permissionUpdatedCallbacks.forEach((cb) => cb(permission));
      }
    } else if (event.type === 'question.asked') {
      const props = event.properties as any;
      if (props && props.id && props.questions) {
        const question: QuestionRequest = {
          id: props.id,
          sessionID: props.sessionID,
          questions: props.questions,
          tool: props.tool,
        };
        this.questionAskedCallbacks.forEach((cb) => cb(question));
      }
    }
  }

  private handleError(error: Error): void {
    this.errorCallbacks.forEach((cb) => cb(error));
  }
}
