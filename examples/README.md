# Example manifests

These two manifests are the fixtures for the golden tests, the authorization tests, and the probe
harness. Their paths are neutral placeholders (`/workspace/blog/posts/`) so the repository does not
carry anyone's real directory layout.

- `blog-publisher.yaml`: an agent that writes and edits files under one posts directory and may
  query a knowledge brain at the cheaper detail levels. No shell, no network, no other paths.
- `gbrain-reader.yaml`: a read-only research agent with three MCP tools, a result cap, and two
  forbidden slug prefixes.

## Dogfood manifests

Manifests with real paths for a real machine belong in `local/`, which is gitignored. Point the
hook at one of them with `--manifest local/<name>.yaml` (or `REMIT_MANIFEST`), and the probe
harness at the same file. Nothing under `local/` is ever committed.

```
mkdir local
cp examples/blog-publisher.yaml local/blog-publisher.yaml
# edit the path_prefixes to the real posts directory
npm run remit -- probe local/blog-publisher.yaml
```
