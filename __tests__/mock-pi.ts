import { EventEmitter } from "node:events";
import type {
	ExtensionAPI,
	ToolInfo,
	EventBus,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

/**
 * MockPI implements the masking-relevant subset of ExtensionAPI for testing.
 *
 * Supports:
 *   setActiveTools / getActiveTools
 *   getAllTools (returns ToolInfo[] objects)
 *   registerTool (populates getAllTools)
 *   appendEntry (records writes keyed by customType)
 *   on (event registration)
 *   events (real Node EventEmitter as EventBus)
 *   sessionManager.getBranch() (returns recorded SessionEntry[])
 *
 * Does NOT expose a readEntry method (none exists on ExtensionAPI).
 */
export class MockPI implements Partial<ExtensionAPI> {
	private _activeTools: string[] = [];
	private _tools: ToolInfo[] = [];
	private _entries: CustomEntryRecord[] = [];
	private _sessionEntries: SessionEntry[] = [];
	private _eventEmitter = new EventEmitter();
	private _handlers = new Map<string, Array<(...args: any[]) => void>>();
	private _eventBus: EventBus | null = null;

	// --- Tool management ---

	registerTool(
		info: Pick<ToolInfo, "name" | "description"> & {
			sourceInfo?: ToolInfo["sourceInfo"];
		},
	): void {
		const tool: ToolInfo = {
			name: info.name,
			description: info.description ?? "",
			parameters: undefined as any,
			sourceInfo: info.sourceInfo ?? {
				path: "mock.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		};
		this._tools.push(tool);
	}

	getAllTools(): ToolInfo[] {
		return [...this._tools];
	}

	setActiveTools(toolNames: string[]): void {
		this._activeTools = [...toolNames];
	}

	getActiveTools(): string[] {
		return [...this._activeTools];
	}

	// --- Persistence ---

	appendEntry<T = unknown>(customType: string, data?: T): void {
		this._entries.push({ customType, data });

		this._sessionEntries.push({
			type: "custom",
			id: `mock-entry-${this._entries.length}`,
			parentId: null,
			timestamp: new Date().toISOString(),
			customType,
			data,
		} as SessionEntry);
	}

	/** Returns recorded appendEntry calls, keyed by customType (for assertions). */
	getEntries(customType?: string): CustomEntryRecord[] {
		if (customType !== undefined) {
			return this._entries.filter((e) => e.customType === customType);
		}
		return [...this._entries];
	}

	/** Clear all recorded entries (for test isolation). */
	clearEntries(): void {
		this._entries = [];
		this._sessionEntries = [];
	}

	// --- Events ---

	on(event: any, handler: any): void {
		const key = String(event);
		if (!this._handlers.has(key)) {
			this._handlers.set(key, []);
		}
		this._handlers.get(key)!.push(handler);
	}

	get events(): EventBus {
		if (!this._eventBus) {
			this._eventBus = {
				emit: (channel: string, data: unknown) => {
					this._eventEmitter.emit(channel, data);
				},
				on: (channel: string, handler: (data: unknown) => void) => {
					this._eventEmitter.on(channel, handler);
					return () => {
						this._eventEmitter.off(channel, handler);
					};
				},
			};
		}
		return this._eventBus;
	}

	/** Check if a handler was registered for a lifecycle event (session_start, session_tree, etc.). */
	hasHandler(event: string): boolean {
		return (this._handlers.get(event)?.length ?? 0) > 0;
	}

	/** Return how many handlers are registered for a given event. */
	handlerCount(event: string): number {
		return this._handlers.get(event)?.length ?? 0;
	}

	/** Fire a lifecycle event (session_start, session_tree) to registered handlers. */
	fireLifecycleEvent(event: string): void {
		const handlers = this._handlers.get(event) ?? [];
		const ctx = this.createContext();
		// Create ONE event object — the real runner passes the same reference
		// to every extension's handler (event-identity dedup).
		const eventObj = {};
		for (const h of handlers) {
			h(eventObj, ctx);
		}
	}

	/** Direct emit for tests that need to simulate events. */
	emit(channel: string, data: unknown): void {
		this._eventEmitter.emit(channel, data);
	}

	// --- Session context ---

	/** Minimal context for event handlers that need ctx.sessionManager.getBranch(). */
	createContext(): ExtensionContext {
		return {
			sessionManager: {
				getBranch: () => [...this._sessionEntries],
				getCwd: () => "/mock",
				getSessionDir: () => "/mock/sessions",
				getSessionId: () => "mock-session-id",
				getSessionFile: () => undefined,
				getLeafId: () => null,
				getLeafEntry: () => undefined,
				getEntry: (_id: string) => undefined,
				getLabel: (_id: string) => undefined,
				getHeader: () => null,
				getEntries: () => [...this._sessionEntries],
				getTree: () => [],
				getSessionName: () => undefined,
			} as any,
			ui: {} as any,
			mode: "tui",
			hasUI: false,
			cwd: "/mock",
			modelRegistry: {} as any,
			model: undefined,
			scopedModels: [],
			isIdle: () => true,
			isProjectTrusted: () => false,
			signal: undefined,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: () => {},
			getSystemPrompt: () => "",
		};
	}
}

export interface CustomEntryRecord {
	customType: string;
	data: unknown;
}
