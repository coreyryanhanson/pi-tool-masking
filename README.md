# pi-tool-masking

Advanced toggling for pi-agent-tools

## Exports

| Export | Kind | Description |
|---|---|---|
| `defineToolset` | function | Register a toolset with the global registry |
| `setDefaultResolutionMode` | function | Switch default resolution to inclusion/exclusion |
| `getDefaultResolutionMode` | function | Read current default resolution mode |
| `getRegisteredToolsets` | function | Snapshot of all registered toolsets (spec + handle) |
| `ToolsetSpec` | interface | Schema for a toolset definition |
| `Toolset` | interface | Handle returned by `defineToolset` |
| `ToolsetChangedEvent` | interface | Shape of emitted events |
| `DefaultResolutionMode` | type | `"exclusion" \| "inclusion"` |
| `RegistryEntry` | interface | `{ spec: ToolsetSpec; toolset: Toolset }` |
| `TOOLSET_EVENTS` | const | Event name constants (`changed`, `restored`) |
