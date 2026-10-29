/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CANVAS_KEEPS, INSPECTOR_MAX, INSPECTOR_MIN, clampInspectorWidth, loadInspectorWidth, saveInspectorWidth,
} from '../src/admin/inspectorWidth'

describe('clampInspectorWidth', () => {
  it('keeps a width between the default and the cap', () => {
    expect(clampInspectorWidth(420.4, 1600)).toBe(420)
    expect(clampInspectorWidth(100, 1600)).toBe(INSPECTOR_MIN)
    expect(clampInspectorWidth(2000, 3000)).toBe(INSPECTOR_MAX)
  })
  it('leaves the canvas its room in a narrow window, never going under the default', () => {
    expect(clampInspectorWidth(700, 1000)).toBe(1000 - CANVAS_KEEPS)
    expect(clampInspectorWidth(700, 600)).toBe(INSPECTOR_MIN)
  })
  it('reads nonsense as the default', () => {
    expect(clampInspectorWidth(Number.NaN, 1600)).toBe(INSPECTOR_MIN)
  })
})

describe('the saved width', () => {
  beforeEach(() => localStorage.clear())
  it('comes back as it was saved, and the default is not kept at all', () => {
    expect(loadInspectorWidth()).toBe(INSPECTOR_MIN)
    saveInspectorWidth(480)
    expect(loadInspectorWidth()).toBe(480)
    saveInspectorWidth(INSPECTOR_MIN)
    expect(localStorage.getItem('fremkit.inspector.width')).toBeNull()
  })
})
