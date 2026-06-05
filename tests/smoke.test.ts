import { expect, test } from 'vitest'
import { VERSION } from '../src/index'

test('VERSION is defined', () => {
  expect(VERSION).toBeDefined()
})
