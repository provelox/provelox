import {
  formatCutover,
  planCutover,
  runCutover,
  type CutoverDeps,
} from './cutover';
import {
  formatPlan,
  planImport,
  runImport,
  type ImportDeps,
  type ImportPlan,
} from './import';
import { formatInventory, inventory } from './inventory';
import { planRetire } from './retire';
import type { SourceApp, SourceRuntime } from './source';
import {
  failures,
  formatChecks,
  verifyImported,
  verifyMigrated,
  type VerifyDeps,
} from './verify';

/** How the wizard talks to the person running it. */
export interface Ui {
  say(text: string): void;
  /** Yes or no. Nothing proceeds on silence. */
  confirm(question: string): Promise<boolean>;
  /** The person has to type this word: for the steps that cannot be undone by the wizard. */
  typed(question: string, word: string): Promise<boolean>;
}

/** Where progress is kept, so a stopped wizard resumes at the stage it stopped at. */
export interface WizardState {
  completed: string[];
  /** Apps whose cutover is done: never copied over again, because Provelox holds their newer data. */
  moved?: string[];
}

export interface Store {
  load(): WizardState;
  save(state: WizardState): void;
}

export interface WizardDeps {
  /** "CapRover", for the wording. */
  sourceTitle: string;
  apps: SourceApp[];
  ui: Ui;
  store: Store;
  importDeps: ImportDeps;
  cutoverDeps: CutoverDeps;
  verify: VerifyDeps;
  /** The old platform: stopping and removing it. */
  runtime: SourceRuntime;
  /** Where an app is reached on Provelox, for the person to open. */
  appUrl(app: string): string;
  /** Sets the instance count of a Provelox app (to start an app for testing). */
  startApp(app: string, instances: number): Promise<void>;
  /** Re-runs the Provelox install on the standard ports so its proxy takes 80 and 443. */
  takeStandardPorts(): Promise<void>;
  /** Waits for the apps to settle after a start; tests make this a no-op. */
  settle(): Promise<void>;
}

type Outcome = 'done' | 'pause';

interface Stage {
  id: string;
  title: string;
  run(): Promise<Outcome>;
}

export const STAGES = [
  'inventory',
  'import',
  'test',
  'cutover',
  'verify',
  'retire',
  'remove',
] as const;

/** Runs the stages in order, stopping wherever the person says stop or a check fails. Safe to run again. */
export async function runWizard(d: WizardDeps): Promise<'finished' | 'paused'> {
  const { ui } = d;
  const old = d.sourceTitle;
  let plans: ImportPlan[] = [];
  const replan = () => (plans = planImport(d.apps));
  replan();

  const state = d.store.load();
  state.moved ??= [];
  /**
   * Apps already on Provelox for good. Remembered as they move, and also recognised by their published ports, so a
   * run whose progress file was lost does not copy the old data over what Provelox has written since.
   */
  const movedApps = async () => {
    const moved = new Set(state.moved);
    for (const p of plans) {
      if (p.skip || p.patch.pendingPorts.length === 0) continue;
      const v = await d.verify.getApp(p.name);
      const has = (x: { hostPort: number; protocol: string }) =>
        v?.app.ports.some(
          (q) => q.hostPort === x.hostPort && q.protocol === x.protocol,
        );
      if (v && p.patch.pendingPorts.every(has)) moved.add(p.name);
    }
    return moved;
  };

  const stages: Stage[] = [
    {
      id: 'inventory',
      title: `Step 1 of 7: What ${d.sourceTitle} runs`,
      async run() {
        ui.say(formatInventory(inventory(d.apps)));
        const todo = plans.filter((p) => !p.skip);
        if (todo.length === 0) {
          ui.say('\nNothing can be imported.');
          return 'pause';
        }
        for (const p of plans.filter((x) => x.skip))
          ui.say(`\n${p.name} stays on ${old}: ${p.skip}`);
        return (await ui.confirm(
          `\nI have read this and want to continue with the ${todo.length} app${todo.length === 1 ? '' : 's'} that can move.`,
        ))
          ? 'done'
          : 'pause';
      },
    },
    {
      id: 'import',
      title: 'Step 2 of 7: Copy the apps to Provelox',
      async run() {
        ui.say(formatPlan(plans));
        ui.say(
          `\n${old} is only read. Data is copied from a read-only mount and verified. Apps with data or host ports are created stopped.`,
        );
        if (!(await ui.confirm('Create these apps on Provelox?')))
          return 'pause';
        const r = await runImport(plans, d.importDeps, old);
        ui.say(`\nImported: ${r.imported.join(', ') || 'none'}`);
        for (const s of r.skipped) ui.say(`Skipped ${s.name}: ${s.reason}`);
        for (const x of r.failed) ui.say(`FAILED ${x.name}: ${x.reason}`);
        if (r.failed.length) {
          ui.say(
            '\nFix the problem and run the wizard again: it carries on from here and leaves apps already imported alone.',
          );
          return 'pause';
        }
        return 'done';
      },
    },
    {
      id: 'test',
      title: 'Step 3 of 7: Check the imported apps and try them',
      async run() {
        const checks = await verifyImported(plans, d.verify, await movedApps());
        ui.say(formatChecks(checks));
        if (failures(checks).length) {
          ui.say(
            '\nSomething did not import correctly. Fix it, then run the wizard again.',
          );
          return 'pause';
        }
        const testable = plans.filter(
          (p) =>
            !p.skip &&
            p.startStopped &&
            p.patch.pendingPorts.length === 0 &&
            p.image,
        );
        if (
          testable.length &&
          (await ui.confirm(
            `\nStart ${testable.map((p) => p.name).join(', ')} on Provelox so you can try them? They use a copy of the data; ${old} keeps running its own.`,
          ))
        ) {
          for (const p of testable) await d.startApp(p.name, p.wantedInstances);
          await d.settle();
        }
        ui.say(
          '\nOpen each app on Provelox and check what only you can check: logins, uploads, background jobs.',
        );
        for (const p of plans.filter(
          (x) => !x.skip && x.patch.pendingPorts.length === 0,
        ))
          ui.say(`  ${p.name}: ${d.appUrl(p.name)}`);
        for (const p of plans.filter(
          (x) => !x.skip && x.patch.pendingPorts.length > 0,
        ))
          ui.say(
            `  ${p.name}: ${d.appUrl(p.name)} (starts at cutover: ${old} holds its host ports)`,
          );
        return (await ui.confirm(
          '\nEverything I could try works, and I want to move on to the cutover.',
        ))
          ? 'done'
          : 'pause';
      },
    },
    {
      id: 'cutover',
      title: 'Step 4 of 7: Cut over',
      async run() {
        const already = await movedApps();
        const steps = planCutover(plans).filter((s) => !already.has(s.app));
        if (already.size)
          ui.say(
            `Already on Provelox, left alone: ${[...already].join(', ')}.\n`,
          );
        ui.say(formatCutover(steps, old));
        ui.say(
          `\nThe apps listed above stop on ${old} and on Provelox while their data is copied again, so they are unavailable for a few minutes.\nThe earlier copy is replaced: anything you changed on Provelox while testing is overwritten.\n${old} is not deleted. If a step fails, the ${old} apps this run stopped are started again.`,
        );
        if (!(await ui.typed('Type "cutover" to begin', 'cutover')))
          return 'pause';
        const r = await runCutover(steps, {
          ...d.cutoverDeps,
          moved: (app) => {
            state.moved = [...new Set([...(state.moved ?? []), app])];
            d.store.save(state);
          },
        });
        if (r.failed) {
          ui.say(`\nFAILED ${r.failed.app}: ${r.failed.reason}`);
          ui.say(
            `${old} apps started again: ${r.restored.join(', ') || 'none'}. ${old}'s proxy was not touched.`,
          );
          return 'pause';
        }
        ui.say(`\nMoved: ${r.done.join(', ') || 'none'}`);
        ui.say(
          `Stopping ${old}'s proxy, then giving Provelox ports 80 and 443.`,
        );
        await d.runtime.stopProxy();
        await d.takeStandardPorts();
        await d.settle();
        return 'done';
      },
    },
    {
      id: 'verify',
      title: 'Step 5 of 7: Check the result',
      async run() {
        const checks = await verifyMigrated(plans, d.verify);
        ui.say(formatChecks(checks));
        const bad = failures(checks);
        if (bad.length) {
          ui.say(
            `\n${bad.length} check${bad.length === 1 ? '' : 's'} failed. Nothing more is changed. Look at the apps, fix them, and run the wizard again to repeat this check.`,
          );
          return 'pause';
        }
        for (const p of plans.filter((x) => !x.skip))
          ui.say(`  ${p.name}: ${d.appUrl(p.name)}`);
        return (await ui.confirm(
          `\nI opened the apps and they work as they did on ${old} (including anything that uses a host port).`,
        ))
          ? 'done'
          : 'pause';
      },
    },
    {
      id: 'retire',
      title: `Step 6 of 7: Stop what is left of ${d.sourceTitle}`,
      async run() {
        const plan = planRetire(await d.runtime.services());
        if (plan.stop.length === 0) {
          ui.say(`Everything of ${old} is already stopped.`);
          return 'done';
        }
        ui.say(`Still running on ${old}: ${plan.stop.join(', ')}`);
        ui.say(`They are stopped, not removed. ${old} can be started again.`);
        if (!(await ui.confirm('Stop them?'))) return 'pause';
        for (const s of plan.stop) {
          ui.say(`  stopping ${s}`);
          await d.runtime.stopService(s);
        }
        return 'done';
      },
    },
    {
      id: 'remove',
      title: `Step 7 of 7: Remove ${d.sourceTitle}`,
      async run() {
        const plan = planRetire(await d.runtime.services());
        if (plan.remove.length === 0) {
          ui.say(`${old} is already gone.`);
          return 'done';
        }
        ui.say(
          `The last step. Best done after Provelox has run for a while (a week, say): until then ${old} is your way back.`,
        );
        ui.say(`Removes these services: ${plan.remove.join(', ')}`);
        ui.say(
          `It does not delete any data: ${old}'s volumes and its data folder stay on the server, and you can remove them yourself when you are sure.`,
        );
        if (!(await ui.confirm(`Remove ${old} now? Answer no to do it later.`)))
          return 'pause';
        const word = `remove ${old.toLowerCase()}`;
        if (!(await ui.typed(`Type "${word}" to confirm`, word)))
          return 'pause';
        for (const s of plan.remove) {
          ui.say(`  removing ${s}`);
          await d.runtime.removeService(s);
        }
        return 'done';
      },
    },
  ];

  for (const stage of stages) {
    if (state.completed.includes(stage.id)) continue;
    ui.say(`\n=== ${stage.title} ===\n`);
    // A stage may follow an earlier one that changed what exists: plan from the current config each time
    replan();
    const outcome = await stage.run();
    if (outcome === 'pause') {
      ui.say(
        `\nStopped before "${stage.title}" finished. Run the wizard again to carry on from this step.`,
      );
      return 'paused';
    }
    state.completed.push(stage.id);
    d.store.save(state);
  }
  ui.say('\nThe migration is complete.');
  return 'finished';
}
