/** Owner-validated settings writes through the real Settings service and Remote controller. */
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { dump } from 'js-yaml'
import { createScope } from '@deepseek-ai/dsh-scope'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SettingsController from '../../../api/settings-controller/src/index.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import AgentPresets from '../src/index.ts'

async function presetFixture(options: { config?: Record<string, unknown>; hmr?: boolean } = {}) {
  const fixture = await configurationFixture({
    hmr: options.hmr ?? false,
    rows: [{ id: 'agent-presets', name: 'cordis:preset', config: options.config ?? { default: 'standard' } }],
    builtins: { preset: AgentPresets },
  })
  await fixture.ctx.plugin(SessionProjectionRegistry)
  await fixture.ctx.plugin(AgentRegistry)
  await fixture.ctx.loader.await()
  const entry = fixture.ctx.configEditor.entries().find(row => row.options.id === 'agent-presets')
  if (entry?.fiber === undefined) throw new Error('agent-presets entry did not activate')
  await entry.fiber.await()
  return { fixture, entry }
}

it('rejects an internal selectedDefault supplied as a constant expression on every write entry', async () => {
  const { fixture } = await presetFixture()
  await fixture.ctx.agentPresets.register({ id: 'standard', plugins: [] })
  await fixture.ctx.agentPresets.register({ id: 'internal', userSelectable: false, plugins: [] })
  await fixture.ctx.plugin(SettingsController)

  const before = fixture.ctx.settings.describe().find(row => row.ns === 'agent-presets')
  if (before === undefined) throw new Error('agent-presets settings row is missing')
  const beforeFile = readFileSync(fixture.profile.patchPath, 'utf8')
  const expression = { selectedDefault: { __jsExpr: "'internal'" } } as never
  const setters = [
    () => fixture.ctx.settingsController.update('agent-presets', expression, undefined),
    () => fixture.ctx.settingsController.replace('agent-presets', expression, undefined),
    () => fixture.ctx.settingsController.mutate('agent-presets', [{
      op: 'set', path: ['selectedDefault'], value: { __jsExpr: "'internal'" },
    }] as never, undefined),
  ]
  for (const set of setters) {
    await expect(set()).rejects.toMatchObject({ code: 'settings/rejected' })
    const after = fixture.ctx.settings.describe().find(row => row.ns === 'agent-presets')
    expect(after?.revision).toBe(before.revision)
    expect(after?.value).toEqual(before.value)
    expect(readFileSync(fixture.profile.patchPath, 'utf8')).toBe(beforeFile)
    expect(fixture.ctx.agentPresets.defaultId).toBe('standard')
  }
})

it('writes a selectable selectedDefault supplied as a constant expression', async () => {
  const { fixture } = await presetFixture()
  await fixture.ctx.agentPresets.register({ id: 'standard', plugins: [] })
  await fixture.ctx.agentPresets.register({ id: 'internal', userSelectable: false, plugins: [] })
  await fixture.ctx.plugin(SettingsController)

  const expression = { selectedDefault: { __jsExpr: "'standard'" } } as never
  const writes = [
    () => fixture.ctx.settingsController.update('agent-presets', expression, undefined),
    () => fixture.ctx.settingsController.replace('agent-presets', expression, undefined),
    () => fixture.ctx.settingsController.mutate('agent-presets', [{
      op: 'set', path: ['selectedDefault'], value: { __jsExpr: "'standard'" },
    }] as never, undefined),
  ]
  for (const write of writes) {
    await write()
    expect(fixture.ctx.settings.describe().find(row => row.ns === 'agent-presets')?.value)
      .toMatchObject({ selectedDefault: 'standard' })
    expect(fixture.ctx.agentPresets.defaultId).toBe('standard')
  }
  expect(readFileSync(fixture.profile.patchPath, 'utf8')).toContain('!!js')
})

it('rejects an internal selectedDefault through the real registry and settings controller', async () => {
  const { fixture } = await presetFixture()
  await fixture.ctx.agentPresets.register({ id: 'standard', plugins: [] })
  await fixture.ctx.agentPresets.register({ id: 'internal', userSelectable: false, plugins: [] })
  await fixture.ctx.plugin(SettingsController)

  const before = fixture.ctx.settings.describe().find(row => row.ns === 'agent-presets')
  if (before === undefined) throw new Error('agent-presets settings row is missing')
  const beforeFile = readFileSync(fixture.profile.patchPath, 'utf8')
  await expect(fixture.ctx.settingsController.update('agent-presets', { selectedDefault: 'internal' }, undefined))
    .rejects.toMatchObject({ code: 'settings/rejected' })

  const after = fixture.ctx.settings.describe().find(row => row.ns === 'agent-presets')
  expect(after?.revision).toBe(before.revision)
  expect(after?.value).toEqual(before.value)
  expect(readFileSync(fixture.profile.patchPath, 'utf8')).toBe(beforeFile)
  expect(fixture.ctx.agentPresets.defaultId).toBe('standard')

  await fixture.ctx.settingsController.update('agent-presets', { selectedDefault: 'standard' }, undefined)
  expect(fixture.ctx.settings.describe().find(row => row.ns === 'agent-presets')?.value)
    .toMatchObject({ selectedDefault: 'standard' })
})

it('starts with a hand-edited internal default and falls back to the deployment default', async () => {
  const { fixture } = await presetFixture({ config: { default: 'standard', selectedDefault: 'internal' } })
  await fixture.ctx.agentPresets.register({ id: 'standard', plugins: [] })
  await fixture.ctx.agentPresets.register({ id: 'internal', userSelectable: false, plugins: [] })

  expect(fixture.ctx.agentPresets.defaultId).toBe('standard')
  const scope = createScope(fixture.ctx, {})
  expect(await fixture.ctx.agentPresets.mount(scope.ctx)).toEqual({ id: 'standard' })
  await scope.dispose()
})

it('keeps the owner config gate after the registry fiber reloads', async () => {
  const { fixture, entry } = await presetFixture()
  await fixture.ctx.agentPresets.register({ id: 'standard', plugins: [] })
  await fixture.ctx.agentPresets.register({ id: 'internal', userSelectable: false, plugins: [] })
  await fixture.ctx.plugin(SettingsController)

  await expect(fixture.ctx.settingsController.update('agent-presets', { selectedDefault: 'internal' }, undefined))
    .rejects.toMatchObject({ code: 'settings/rejected' })
  const fiber = entry.fiber
  if (fiber === undefined) throw new Error('agent-presets fiber is missing')
  await fiber.restart()
  await fiber.await()
  await fixture.ctx.agentPresets.register({ id: 'standard', plugins: [] })
  await fixture.ctx.agentPresets.register({ id: 'internal', userSelectable: false, plugins: [] })

  await expect(fixture.ctx.settingsController.update('agent-presets', { selectedDefault: 'internal' }, undefined))
    .rejects.toMatchObject({ code: 'settings/rejected' })
  await fixture.ctx.settingsController.update('agent-presets', { selectedDefault: 'standard' }, undefined)
  expect(fixture.ctx.settings.describe().find(row => row.ns === 'agent-presets')?.value)
    .toMatchObject({ selectedDefault: 'standard' })
})

it('falls back when a saved selectable default becomes internal after the write', async () => {
  const { fixture } = await presetFixture()
  await fixture.ctx.agentPresets.register({ id: 'standard', plugins: [] })
  const disposeMinimal = await fixture.ctx.agentPresets.register({ id: 'minimal', plugins: [] })
  await fixture.ctx.plugin(SettingsController)
  await fixture.ctx.settingsController.mutate('agent-presets', [{ op: 'set', path: ['selectedDefault'], value: 'minimal' }], undefined)
  expect(fixture.ctx.agentPresets.defaultId).toBe('minimal')

  await disposeMinimal()
  await fixture.ctx.agentPresets.register({ id: 'minimal', userSelectable: false, plugins: [] })
  expect(fixture.ctx.agentPresets.defaultId).toBe('standard')
  const scope = createScope(fixture.ctx, {})
  expect(await fixture.ctx.agentPresets.mount(scope.ctx)).toEqual({ id: 'standard' })
  await scope.dispose()
})

it('accepts a direct live config update of the same value Settings refuses', async () => {
  const { fixture, entry } = await presetFixture()
  await fixture.ctx.agentPresets.register({ id: 'standard', plugins: [] })
  await fixture.ctx.agentPresets.register({ id: 'internal', userSelectable: false, plugins: [] })
  await fixture.ctx.plugin(SettingsController)

  const beforeFile = readFileSync(fixture.profile.patchPath, 'utf8')
  await expect(fixture.ctx.settingsController.update('agent-presets', { selectedDefault: 'internal' }, undefined))
    .rejects.toMatchObject({ code: 'settings/rejected' })
  expect(readFileSync(fixture.profile.patchPath, 'utf8')).toBe(beforeFile)
  expect(fixture.ctx.agentPresets.defaultId).toBe('standard')

  // A direct Loader update is not a Settings write: it keeps the supplied value
  // and the effective default falls back instead of rejecting the reload.
  await entry.update({ config: { default: 'standard', selectedDefault: 'internal' } })
  await entry.fiber!.await()
  expect(entry.options.config).toMatchObject({ selectedDefault: 'internal' })
  expect(fixture.ctx.settings.describe().find(row => row.ns === 'agent-presets')?.value)
    .toMatchObject({ selectedDefault: 'internal' })
  expect(fixture.ctx.agentPresets.defaultId).toBe('standard')
  expect(readFileSync(fixture.profile.patchPath, 'utf8')).toBe(beforeFile)
  const scope = createScope(fixture.ctx, {})
  expect(await fixture.ctx.agentPresets.mount(scope.ctx)).toEqual({ id: 'standard' })
  await scope.dispose()
})

it('reloads a profile patch that names an internal default without rejecting, then keeps the Settings gate', async () => {
  const { fixture, entry } = await presetFixture({ hmr: true })
  await fixture.ctx.agentPresets.register({ id: 'standard', plugins: [] })
  await fixture.ctx.agentPresets.register({ id: 'internal', userSelectable: false, plugins: [] })
  await fixture.ctx.plugin(SettingsController)

  // The user patch layer overrides the bundle row. Reloading it is a Loader
  // update, not a Settings write, so an internal name must load and fall back.
  writeFileSync(fixture.profile.patchPath, dump([{
    id: 'agent-presets', name: 'cordis:preset', config: { default: 'standard', selectedDefault: 'internal' },
  }]))
  await fixture.ctx.hmr.runExclusive(() => fixture.ctx.hmr.reconcileProfile(['agent-presets']))
  await entry.fiber!.await()

  expect(entry.options.config).toMatchObject({ selectedDefault: 'internal' })
  expect(fixture.ctx.settings.describe().find(candidate => candidate.ns === 'agent-presets')?.value)
    .toMatchObject({ selectedDefault: 'internal' })
  expect(fixture.ctx.agentPresets.defaultId).toBe('standard')

  // The volatile reload keeps the same registry fiber, so the owner check is
  // still registered for the next Settings write.
  await expect(fixture.ctx.settingsController.update('agent-presets', { selectedDefault: 'internal' }, undefined))
    .rejects.toMatchObject({ code: 'settings/rejected' })
  await fixture.ctx.settingsController.update('agent-presets', { selectedDefault: 'standard' }, undefined)
  expect(fixture.ctx.agentPresets.defaultId).toBe('standard')
})
