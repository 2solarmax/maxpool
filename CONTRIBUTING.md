# Contributing to maxpool

Thanks for helping. Pull requests are welcome.

## License of your contribution

maxpool is MIT-licensed. By opening a pull request you agree that your
contribution is licensed under the same MIT license as the rest of the project
(see [LICENSE](LICENSE)), and that you have the right to contribute it.

## Before you open a pull request

- One topic per commit, with a message that says what changes for the user.
- Add or update tests for what you change. Run `npm test` with an isolated
  `HOME` so the suite never touches your real config, then `npx eslint src/ test/`.
- Leave the version and the CHANGELOG alone. They change at release time.
- Never add IP or residential proxies, fingerprint spoofing or traffic
  interception. See "Read this first" in the README: those PRs are closed.

## What happens after you open it

- The first time you contribute, GitHub waits for the maintainer to approve your
  test run. After that, tests run on every push to your branch.
- Pull requests run the tests on one Node version. The full Node matrix runs
  after merge.
- The maintainer may push small follow-up commits to your branch (when "Allow
  edits by maintainers" is ticked) to get it ready to merge. Your commits and
  authorship stay as they are.
- Changes under `.github/` (workflows, CI) get a closer review before their run
  is approved.

## Reporting a security problem

Please don't open a public issue. See [SECURITY.md](SECURITY.md).
