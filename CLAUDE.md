<!-- align:start -->
## align — architecture conformance

This repo is checked by [align](https://github.com) for dependency-direction and import-cycle
conformance. Run `align check` (or the `align_check` MCP tool if the align MCP server is
connected) after any structural code change — new imports, moved files, restructured modules.

**A red `align check` is blocking.** Do not consider a structural change complete while
`align check` reports red. Run `align explain <ruleId>` (or the `align_explain_rule` MCP tool)
to understand why a rule fired before proposing a fix.
<!-- align:end -->
