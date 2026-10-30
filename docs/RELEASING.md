# npm releases

The public package is `@dylanl1/dsh-plugin-pdf`. Its five native dependencies
use the same exact version and the suffix `-native-<platform>-<arch>`. Each
native package contains the worker, PDFium library, integrity manifest and
licenses in `bin/`. The main package contains Host, Client and public SDK entries.
Installation runs no build or download hooks.

## Build and verify

1. Update the root version and lockfile without changing unrelated dependencies.
   Native package versions and the published main package's five exact optional
   dependencies are generated from this version. The source checkout deliberately
   does not require unpublished native packages, so its locked bootstrap remains usable.
2. Run the complete project checks. Push a review branch matching `feat/npm-*`
   or use a pull request to run the five-platform installation matrix and Web /
   project coverage checks.
3. Use the six package archives from the same successful workflow run:
   `dsh-pdf-main` and the five `dsh-pdf-native-<target>` artifacts. Do not mix
   runs or publish the old platform-specific complete plugin archives.

On a source checkout, `npm run native:build`, `npm run build`,
`npm run package:native -- <target>` and `npm run package:main` create the
current platform's packages. `npm run package:smoke -- --main <main.tgz>
--native <native.tgz>` checks a clean install, a real PDFium handshake and
independent compilation of the four engine SDKs. `--offline` reuses npm's cache.

## First publication

Log in with `npm login` and confirm the publishing account with `npm whoami`.
Keep credentials out of the repository and chat. Download the six verified
archives into one directory, then run:

```sh
npm run release:publish -- --artifacts /absolute/path/to/release-packages --dry-run
npm run release:publish -- --artifacts /absolute/path/to/release-packages
```

The publisher validates all six archives before any registry write, checks
existing registry integrity, publishes the native dependencies first and the
main package last. A retry skips an already published byte-identical archive;
different content under the same version requires a new version.

After publication, verify automatic native selection from the registry alone:

```sh
npm run package:smoke -- --package @dylanl1/dsh-plugin-pdf@0.1.2
```

Use the version being released in that command. Ordinary users install only
the main package through DSH's plugin manager.

## CI publications

Once, configure npm Trusted Publishing in npm's settings for **each of the six
existing packages**, using GitHub owner
`dingyiliao`, repository `dsh-bundle-pdf`, and workflow filename `native.yml`.
Allow direct `npm publish`, not only staged publishing. This requires access to
the publishing npm account; no npm token or repository secret is needed.
npm requires CLI
11.5.1 or newer and Node 22.14 or newer; the release job uses Node 24.
See [npm's setup instructions](https://docs.npmjs.com/trusted-publishers/).

- **Automatic:** increase the root `package.json` version and update its lockfile,
  then push to `main`. The gate compares the entire push's before/after versions,
  including pushes containing multiple commits. An unchanged version does not
  publish. The workflow never changes the version for you.
- **Manual or retry:** run `native.yml` on `main` with `publish` enabled. This also
  supports a first publication when a new `main` branch has no previous baseline.
- Both paths publish only stable `x.y.z` versions. Prereleases and build-metadata
  versions are skipped; this workflow has no prerelease dist-tag policy. Automatic
  downgrades or an unreadable previous baseline fail closed. Pull requests,
  feature branches and manual runs without `publish` never publish.

Publication waits for all five platform builds, clean installation checks,
Web tests, 100% project line coverage and the main-package build. It uses only
the six archives from that same run, publishing native packages first and the
plugin last through OIDC. Releases run serially; immediately before publishing,
the job checks that its package version still matches remote `main` and skips
superseded runs so an older build cannot move `latest` backwards.

The existing publisher skips byte-identical published archives and rejects
different content under the same version. Retry the failed run when possible;
if a new build produces conflicting bytes, increase the version rather than
overwriting a published release.
