/** Owner-validated settings writes through the real Settings service and Remote controller. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SettingsController from '../../../api/settings-controller/src/index.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import AgentPresets from '../src/index.ts'

it('rejects an internal selectedDefault supplied as a constant expression on every write entry', async () => {
  const fixture = await configurationFixture({
    hmr: false,
    rows: [{ id: 'agent-presets', name: 'cordis:preset', config: { default: 'standard' } }],
    builtins: { preset: AgentPresets },
  })
  await fixture.ctx.plugin(SessionProjectionRegistry)
  await fixture.ctx.loader.await()
  const entry = fixture.ctx.configEditor.entries().find(row => row.options.id === 'agent-presets')
  if (entry?.fiber === undefined) throw new Error('agent-presets entry did not activate')
  await entry.fiber.await()
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

it('rejects an internal selectedDefault through the real registry and settings controller', async () => {
  const fixture = await configurationFixture({
    hmr: false,
    rows: [{ id: 'agent-presets', name: 'cordis:preset', config: { default: 'standard' } }],
    builtins: { preset: AgentPresets },
  })
  await fixture.ctx.plugin(SessionProjectionRegistry)
  await fixture.ctx.loader.await()
  const entry = fixture.ctx.configEditor.entries().find(row => row.options.id === 'agent-presets')
  if (entry?.fiber === undefined) throw new Error('agent-presets entry did not activate')
  await entry.fiber.await()
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
