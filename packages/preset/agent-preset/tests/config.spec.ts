/** The Loader-facing preset row schema, not just its TypeScript shape. */
import { expect, it } from 'vitest'
import AgentPreset from '../src/index.ts'

const validate = (config: unknown) => AgentPreset.Config['~standard'].validate(config)

it('accepts omitted, true and false userSelectable values', () => {
  expect(validate({ id: 'standard', plugins: [] })).not.toHaveProperty('issues')
  expect(validate({ id: 'internal', userSelectable: false, plugins: [] })).not.toHaveProperty('issues')
  expect(validate({ id: 'visible', userSelectable: true, plugins: [] })).not.toHaveProperty('issues')
})

it('rejects string and numeric userSelectable values', () => {
  expect(validate({ id: 'bad', userSelectable: 'false', plugins: [] })).toHaveProperty('issues')
  expect(validate({ id: 'bad', userSelectable: 0, plugins: [] })).toHaveProperty('issues')
})
