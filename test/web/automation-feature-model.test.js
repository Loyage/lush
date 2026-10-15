import { test, expect } from 'bun:test';
import { AUTOMATION_METADATA, DISPLAY_PRINCIPLES, automationMetadata, automationDefaultShown } from '../../src/ui/web/assets/automation-features.js';

test('one shared metadata source describes three current settings features, excluding conditional emission', () => {
  expect(AUTOMATION_METADATA.map(item => item.id)).toEqual(['completion', 'push', 'acceptance_notice']);
  for (const feature of AUTOMATION_METADATA) {
    expect(feature.name.length).toBeGreaterThan(0); expect(feature.description.length).toBeGreaterThan(0); expect(feature.principle.length).toBeGreaterThan(0);
    expect(automationMetadata(feature.id)).toBe(feature);
  }
  expect(DISPLAY_PRINCIPLES.map(item => item.value)).toEqual(['main', 'all', 'user']);
});

test('default display is not execution authorization; all starts visible, main and user only fold excluded Workers', () => {
  for (const task_kind of ['main', 'owner', 'order', 'say', 'child']) for (const { id } of AUTOMATION_METADATA) {
    const task = { task_kind };
    expect(automationDefaultShown(id, task, null)).toBe(true);
    expect(automationDefaultShown(id, task, { [id]: 'all' })).toBe(true);
    expect(automationDefaultShown(id, task, { [id]: 'main' })).toBe(['main', 'owner'].includes(task_kind));
    expect(automationDefaultShown(id, task, { [id]: 'user' })).toBe(['main', 'owner', 'order', 'say'].includes(task_kind));
  }
});

test('user display principle excludes internal and inapplicable Worker types, including unknown/missing kinds', () => {
  for (const task_kind of ['child', 'analysis', 'integration', 'merge', 'management', 'unknown', null, undefined]) {
    const task = { task_kind };
    for (const { id } of AUTOMATION_METADATA) {
      expect(automationDefaultShown(id, task, { [id]: 'user' })).toBe(false);
      expect(automationDefaultShown(id, task, { [id]: 'main' })).toBe(false);
    }
  }
  expect(automationDefaultShown('completion', null, { completion: 'user' })).toBe(false);
});
