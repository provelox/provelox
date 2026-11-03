# Adding a source

A *source* is a platform Provelox can migrate from. The migration engine, the wizard and the verification know nothing
about any particular platform: they work on a small set of shapes, and a source translates its platform into them.

## Layout

```
src/migrate/
  core/                 the engine: plan, import, cutover, verify, retire, the wizard
    source.ts           the contract a source implements
  sources/
    index.ts            the list of sources
    caprover/           the first source
      config.ts         reads the platform's configuration into SourceApp[]
      runtime.ts        stops, restores and removes the platform's services
      index.ts          the MigrationSource that ties them together
```

## The contract

A source implements `MigrationSource` (see `core/source.ts`):

- `id`, `title` and `options`: how it is named on the command line and which flags it reads.
- `read(flags)`: returns the platform's apps as `SourceApp[]`: image, port, instances, environment (already
  resolved), volumes, host ports, domains, and anything that blocks or needs attention. **Read-only**: it must never
  change the platform.
- `runtime(context)`: a `SourceRuntime` that can stop an app and free its host ports, wait for it to stop, stop the
  platform's web proxy, list its services in the order to stop them, and stop or remove one. Everything it does is
  reversible except `removeService`, which must refuse any name that is not the platform's own.

## Steps

1. Create `src/migrate/sources/<id>/` with a `MigrationSource`.
2. Add it to `SOURCES` in `src/migrate/sources/index.ts`.
3. Test the mapping in the source's own spec. The core has its own tests against a neutral fixture
   (`core/test-apps.ts`) and needs none for a new source.

`provelox migrate --from <id>` then works with no further changes.
