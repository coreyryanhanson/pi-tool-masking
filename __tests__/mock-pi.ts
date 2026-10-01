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
/** Widened ToolInfo fixture: `exposure` optional (0.99 types require the
 *  field on ToolInfo; the mock must be able to represent its ABSENCE so the
 *  "missing exposure reproduces current behaviour" tests stay honest). */
type MockToolInfo = Omit<ToolInfo, "exposure"> & { exposure?: string };

export class MockPI implements Partial<ExtensionAPI> {
	private _activeTools: string[] = [];
	private _tools: MockToolInfo[] = [];
	/** Full setActiveTools call history (raw arguments). */
	private _setActiveCalls: string[][] = [];
	private _entries: CustomEntryRecord[] = [];
	private _sessionEntries: SessionEntry[] = [];
	private _eventEmitter = new EventEmitter();
	private _handlers = new Map<string, Array<(...args: any[]) => void>>();
	private _eventBus: EventBus | null = null;

	// --- Tool management ---

	registerTool(
		info: Pick<ToolInfo, "name" | "description"> & {
			sourceInfo?: ToolInfo["sourceInfo"];
			exposure?: string;
		},
	): void {
		// `exposure` is stored only when provided — NO default. With a default
		// the field is never absent and the "missing exposure reproduces current
		// behaviour" tests become tautological.
		const tool: MockToolInfo = {
			name: info.name,
			description: info.description ?? "",
			parameters: undefined as any,
			sourceInfo: info.sourceInfo ?? {
				path: "mock.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
			...(info.exposure ? { exposure: info.exposure } : {}),
		};
		// Replace any existing same-name entry — real pi rebuilds a
		// name→definition map on refresh, so re-registering a name replaces it
		// (e.g. an MCP server re-registering a dropped tool as `hidden`).
		const i = this._tools.findIndex((t) => t.name === info.name);
		if (i >= 0) this._tools[i] = tool;
		else this._tools.push(tool);
	}

	// Widened fixture type under a required-`exposure` ToolInfo return.
	getAllTools(): ToolInfo[] {
		return [...this._tools] as unknown as ToolInfo[];
	}

	setActiveTools(toolNames: string[]): void {
		// Record the RAW arguments before filtering — the per-turn tests assert
		// that the library never hands a hidden name over in the first place.
		this._setActiveCalls.push([...toolNames]);
		// Mirror pi's filter: hidden-exposure names are silently dropped from
		// the active set.
		this._activeTools = toolNames.filter((n) => {
			const t = this._tools.find((tool) => tool.name === n);
			return !t || t.exposure !== "hidden";
		});
	}

	/** Full call history (raw arguments, pre-filter) — `getActiveTools()` state
	 *  alone cannot show a redundant identical-list rewrite. */
	getSetActiveCalls(): string[][] {
		return this._setActiveCalls.map((c) => [...c]);
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

	// --- Events ---

	on(event: any, handler: any): () => void {
		const key = String(event);
		if (!this._handlers.has(key)) {
			this._handlers.set(key, []);
		}
		this._handlers.get(key)!.push(handler);
		return () => {
			const list = this._handlers.get(key);
			if (!list) return;
			const i = list.indexOf(handler);
			if (i >= 0) list.splice(i, 1);
		};
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

	/**
	 * Fire a lifecycle event (session_start, session_tree) to registered
	 * handlers. `payload` is merged into the single event object — e.g.
	 * `{ type: "session_start", reason: "startup" }` — matching the real
	 * runner's event shape (e.g. `SessionStartEvent`).
	 */
	fireLifecycleEvent(event: string, payload?: Record<string, unknown>): void {
		const handlers = this._handlers.get(event) ?? [];
		const ctx = this.createContext();
		// Create ONE event object — the real runner passes the same reference
		// to every extension's handler (event-identity dedup).
		const eventObj = { ...payload };
		for (const h of handlers) {
			h(eventObj, ctx);
		}
	}

	// --- Session context ---

	/** Minimal context: the library only ever reads ctx.sessionManager.getBranch().
	 *  ponytail: add stub fields here if index.ts starts touching more ctx surface. */
	createContext(): ExtensionContext {
		return {
			sessionManager: {
				getBranch: () => [...this._sessionEntries],
			},
		} as unknown as ExtensionContext;
	}
}

export interface CustomEntryRecord {
	customType: string;
	data: unknown;
}
