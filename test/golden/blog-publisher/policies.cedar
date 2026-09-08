// Remit policy set for agent blog-publisher, purpose agorme-blog-publish
// policy_version f74bcee6f866def750be2ecfa1bb030512423832137a57748d4132db73568fff
// expires 2027-03-31T00:00:00.000Z
// Generated from the purpose manifest. Edit the manifest, not this file.
@id("agorme-blog-publish.Write")
@purpose_id("agorme-blog-publish")
@policy_version("f74bcee6f866def750be2ecfa1bb030512423832137a57748d4132db73568fff")
@tool("Write")
permit(
  principal == Agent::"blog-publisher",
  action == Action::"Write",
  resource
)
when {
  context.purpose_id == "agorme-blog-publish" &&
  context.now < datetime("2027-03-31T00:00:00.000Z") &&
  resource.path like "C:/Users/ariel/.claude/projects/agor.me/src/app/blog/posts/*"
};

@id("agorme-blog-publish.Edit")
@purpose_id("agorme-blog-publish")
@policy_version("f74bcee6f866def750be2ecfa1bb030512423832137a57748d4132db73568fff")
@tool("Edit")
permit(
  principal == Agent::"blog-publisher",
  action == Action::"Edit",
  resource
)
when {
  context.purpose_id == "agorme-blog-publish" &&
  context.now < datetime("2027-03-31T00:00:00.000Z") &&
  resource.path like "C:/Users/ariel/.claude/projects/agor.me/src/app/blog/posts/*" &&
  context.arg_regex_ok == true
};

@id("agorme-blog-publish.mcp__gbrain__query")
@purpose_id("agorme-blog-publish")
@policy_version("f74bcee6f866def750be2ecfa1bb030512423832137a57748d4132db73568fff")
@tool("mcp__gbrain__query")
permit(
  principal == Agent::"blog-publisher",
  action == Action::"mcp__gbrain__query",
  resource
)
when {
  context.purpose_id == "agorme-blog-publish" &&
  context.now < datetime("2027-03-31T00:00:00.000Z") &&
  context.args has "detail" && ["low", "medium"].contains(context.args["detail"])
};

@id("agorme-blog-publish.purpose-mismatch")
@purpose_id("agorme-blog-publish")
@policy_version("f74bcee6f866def750be2ecfa1bb030512423832137a57748d4132db73568fff")
forbid(
  principal == Agent::"blog-publisher",
  action,
  resource
)
unless {
  context.purpose_id == "agorme-blog-publish"
};

@id("agorme-blog-publish.expired")
@purpose_id("agorme-blog-publish")
@policy_version("f74bcee6f866def750be2ecfa1bb030512423832137a57748d4132db73568fff")
forbid(
  principal == Agent::"blog-publisher",
  action,
  resource
)
when {
  context.now >= datetime("2027-03-31T00:00:00.000Z")
};
