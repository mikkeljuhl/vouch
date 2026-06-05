import { expect, test } from 'bun:test'
import { VERSION } from '../src/index'

test('VERSION is defined', () => {
  expect(VERSION).toBeDefined()
})
