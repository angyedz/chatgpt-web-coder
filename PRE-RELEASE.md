# Pre-release channel

This is the dedicated `pre-release` branch for experimental Windows builds of chatgpt-web-coder.

- `main` publishes stable GitHub Releases.
- `pre-release` publishes GitHub Pre-releases after Windows CI succeeds.
- Feature branches and pull requests run CI only; they do not publish releases.
- In the terminal choose `/update settings channel pre-release` to follow this channel.
- `/update check` and `/update latest` respect the saved channel.
- Installation still requires explicit `/update apply`.

Do not treat prereleases as validated stable builds. Promote tested changes to `main` by review.
