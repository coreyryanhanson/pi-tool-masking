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

	// --- Tool management ---

	registerTool(info: Pick<ToolInfo, "name" | "description">): void {
		const tool: ToolInfo = {
			name: info.name,
			description: info.description ?? "",
			parameters: undefined as any,
			sourceInfo: {
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

	on: ExtensionAPI["on"] = (_event: any, _handler: any) => {
		// ponytail: no-op stub for Sprint 0. Sprint 1's defineToolset calls
		// pi.on("session_start", ...) and pi.on("session_tree", ...) to register
		// restore handlers. When the tests need to capture those registrations,
		// this must store handlers keyed by event name.
	};

	get events(): EventBus {
		return {
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
			isIdle: () => true,
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
