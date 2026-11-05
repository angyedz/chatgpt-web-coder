# Publishing on GitHub

[Русская версия](GITHUB.md)

## Connect the repository

Create an empty repository on GitHub and choose its visibility. The project folder already contains a local Git repository. Add the new remote and push `main`:

```powershell
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
```

Replace `OWNER/REPOSITORY` with your repository. If `origin` is already configured, inspect it with `git remote -v` first. Do not commit `.env`, credentials, sessions, or logs; `.gitignore` excludes them.

## Checks and releases

The [Windows CI workflow](../.github/workflows/windows-release.yml) installs dependencies and Chromium, checks types, runs the test suite, and builds the Windows update ZIP. Pushes to `main` and pull requests run these checks.

After a successful push build on `main`, the verified release workflow publishes a GitHub Release with tag `build-<run-id>-<attempt>`. Pull requests do not publish releases. The release includes `chatgpt-coder-windows.zip` and `SHA256SUMS.txt`.

The build tag is unique per workflow run even if `package.json` has not changed. To show a new product version in the app, update both `package.json` and `package-lock.json` before publishing. Each workflow run creates its own release. An older build that finishes later must not replace the newest verified release as **Latest**.

To run the workflow manually, open **Actions → Windows CI and release → Run workflow** and select `main`. GitHub Actions must be enabled, and the built-in `GITHUB_TOKEN` needs permission to publish releases (`contents: write`). No separate secret is required.

The checksum detects archive corruption; it is not a digital signature. Only install archives from a source you trust.
