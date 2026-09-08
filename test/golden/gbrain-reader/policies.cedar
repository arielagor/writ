// Writ policy set for agent gbrain-reader, purpose gbrain-read-only
// policy_version 59edfcb44d87d8bbcf9d8786fd7eab8c28366ad9c4b22cfa9b43d50be170e24c
// expires 2026-12-31T23:59:59.000Z
// Generated from the purpose manifest. Edit the manifest, not this file.
@id("gbrain-read-only.mcp__gbrain__query")
@purpose_id("gbrain-read-only")
@policy_version("59edfcb44d87d8bbcf9d8786fd7eab8c28366ad9c4b22cfa9b43d50be170e24c")
@tool("mcp__gbrain__query")
permit(
  principal == Agent::"gbrain-reader",
  action == Action::"mcp__gbrain__query",
  resource
)
when {
  context.purpose_id == "gbrain-read-only" &&
  context.now < datetime("2026-12-31T23:59:59.000Z") &&
  context.arg_regex_ok == true
};

@id("gbrain-read-only.mcp__gbrain__search")
@purpose_id("gbrain-read-only")
@policy_version("59edfcb44d87d8bbcf9d8786fd7eab8c28366ad9c4b22cfa9b43d50be170e24c")
@tool("mcp__gbrain__search")
permit(
  principal == Agent::"gbrain-reader",
  action == Action::"mcp__gbrain__search",
  resource
)
when {
  context.purpose_id == "gbrain-read-only" &&
  context.now < datetime("2026-12-31T23:59:59.000Z")
};

@id("gbrain-read-only.mcp__gbrain__get_page")
@purpose_id("gbrain-read-only")
@policy_version("59edfcb44d87d8bbcf9d8786fd7eab8c28366ad9c4b22cfa9b43d50be170e24c")
@tool("mcp__gbrain__get_page")
permit(
  principal == Agent::"gbrain-reader",
  action == Action::"mcp__gbrain__get_page",
  resource
)
when {
  context.purpose_id == "gbrain-read-only" &&
  context.now < datetime("2026-12-31T23:59:59.000Z") &&
  context.arg_regex_ok == true
};

@id("gbrain-read-only.purpose-mismatch")
@purpose_id("gbrain-read-only")
@policy_version("59edfcb44d87d8bbcf9d8786fd7eab8c28366ad9c4b22cfa9b43d50be170e24c")
forbid(
  principal == Agent::"gbrain-reader",
  action,
  resource
)
unless {
  context.purpose_id == "gbrain-read-only"
};

@id("gbrain-read-only.expired")
@purpose_id("gbrain-read-only")
@policy_version("59edfcb44d87d8bbcf9d8786fd7eab8c28366ad9c4b22cfa9b43d50be170e24c")
forbid(
  principal == Agent::"gbrain-reader",
  action,
  resource
)
when {
  context.now >= datetime("2026-12-31T23:59:59.000Z")
};
