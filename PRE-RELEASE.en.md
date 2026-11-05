# Pre-release channel

[Русская версия](PRE-RELEASE.md)

This branch is reserved for experimental Windows builds of chatgpt-coder.

- `main` publishes stable GitHub Releases.
- `pre-release` publishes GitHub Pre-releases after Windows CI succeeds.
- Feature branches and pull requests run CI only; they do not publish releases.
- In the terminal, run `/update settings channel pre-release` to follow this channel.
- `/update check` and `/update latest` use the saved channel.
- Installation still requires the explicit `/update apply` command.

Treat pre-releases as experimental. Promote changes to `main` only after review and validation.
