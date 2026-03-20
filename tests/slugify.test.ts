import { describe, it, expect } from 'vitest'
import { slugify } from '../src/slugify.js'

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('Valhalla Routing')).toBe('valhalla-routing')
  })
  it('strips non-alphanumeric characters', () => {
    expect(slugify('My API (v2)!')).toBe('my-api-v2')
  })
  it('collapses multiple hyphens', () => {
    expect(slugify('foo---bar')).toBe('foo-bar')
  })
  it('trims leading and trailing hyphens', () => {
    expect(slugify('--hello--')).toBe('hello')
  })
})
