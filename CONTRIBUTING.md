# Contributing to Provelox

> **Pull requests are not being accepted yet.** For now, please open an
> [issue](https://github.com/provelox/provelox/issues): a bug report, an idea or a question. We are working out how
> outside changes will flow into the project, and this page will say when pull requests are welcome. The rest of it
> describes how contributions will work.

Thanks for helping. Provelox is licensed under the [Apache License 2.0](LICENSE). Contributions are accepted under the
same license, and you keep the copyright on what you write.

## Sign your commits (DCO)

Every commit needs a `Signed-off-by:` line with your real name and an address you can be reached at:

```sh
git commit -s -m "Fix the thing"
```

which adds

```
Signed-off-by: Your Name <you@example.com>
```

By adding it you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/):

> By making a contribution to this project, I certify that:
>
> (a) The contribution was created in whole or in part by me and I have the right to submit it under the open source
> license indicated in the file; or
>
> (b) The contribution is based upon previous work that, to the best of my knowledge, is covered under an appropriate
> open source license and I have the right under that license to submit that work with modifications, whether created
> in whole or in part by me, under the same open source license (unless I am permitted to submit under a different
> license), as indicated in the file; or
>
> (c) The contribution was provided directly to me by some other person who certified (a), (b) or (c) and I have not
> modified it.
>
> (d) I understand and agree that this project and the contribution are public and that a record of the contribution
> (including all personal information I submit with it, including my sign-off) is maintained indefinitely and may be
> redistributed consistent with this project or the open source license(s) involved.

A pull request fails its DCO check until every commit has a sign-off. To add one to commits you have already made:
`git rebase --signoff main`, then push with `--force-with-lease`.

## Before you open a pull request

Each folder is its own project; see the README for how to run its tests. Keep a change focused, add a test for a fix,
and add a line to `CHANGELOG.md` for anything a user would notice.

## The name

The Apache license does not give anyone the right to use the Provelox name or logo. You are welcome to say that your
work is based on, compatible with or a fork of Provelox. Please do not name a product or service in a way that suggests
it is the official one.

## Writing about other tools

Provelox is one tool among many, and people reach it from others. In the docs, the README and anywhere else we write:

- **Describe what Provelox does, not what it replaces or beats.** No "replaces X", "alternative to X", "better than X" or
  feature-by-feature scorecards. They age badly and they are claims about someone else's product.
- **Help people who come from another tool with a "Coming from X?" page**, under `docs/migration/`: what maps to what,
  what Provelox moves for you, what it does not, and what to check afterwards. Link to it from the place a newcomer would
  look (the introduction, the install guide), in one sentence ("Coming from CapRover? See [From CapRover](...)").
  [Adding a source](docs/migration/adding-a-source.md) covers the migration tool itself.
- **Name other tools plainly and only to be useful**: their real name, spelled as they spell it, with nothing implied about
  endorsement or affiliation. State only what you can verify, and say what you checked against (a version, a date).
- **Be kind about them.** Many are small open-source projects with people behind them.
