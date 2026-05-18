// Phase 3 — conversational memory: anaphora ("it"/"that"/"#2"/"first"/"last").
import { describe, it, expect } from 'vitest';
import { parseAssistantMessage } from '../src/utils/assistant/nlu.js';

const ctx = {
  clientNames: ['ACME Pvt Ltd', 'Beta Events'],
  vendorNames: ['Truss World'],
  employeeNames: ['Ramesh Kumar', 'Priya Sharma'],
  projectNames: ['Wedding Spectacular', 'Concert Aug', 'Done Show'],
  inventoryNames: [],
};

describe('Phase 3 NLU — anaphora & memory', () => {
  it('returns no resolvedFromMemory when memory is null', () => {
    const r = parseAssistantMessage('confirm it', ctx, null);
    // Bare verb keyword "confirm" matches but no projectName → required-entity error.
    expect(r.intent).toBe('project.confirm');
    expect(r.resolvedFromMemory).toBeUndefined();
    expect(r.issues.some((i) => /project name/i.test(i.message))).toBe(true);
  });

  it('resolves "confirm it" via memory.lastEntities.projectName', () => {
    const memory = { lastEntities: { projectName: 'Wedding Spectacular' }, lastResultRows: [], lastIntent: null };
    const r = parseAssistantMessage('confirm it', ctx, memory);
    expect(r.intent).toBe('project.confirm');
    expect(r.entities.projectName).toBe('Wedding Spectacular');
    expect(r.resolvedFromMemory).toBe(true);
    expect(r.issues.some((i) => /project name/i.test(i.message))).toBe(false);
  });

  it('resolves "close that" → project.markClosed with last project', () => {
    const memory = { lastEntities: { projectName: 'Done Show' }, lastResultRows: [], lastIntent: null };
    const r = parseAssistantMessage('close that', ctx, memory);
    expect(r.intent).toBe('project.markClosed');
    expect(r.entities.projectName).toBe('Done Show');
  });

  it('resolves "complete it" → project.markCompleted', () => {
    const memory = { lastEntities: { projectName: 'Concert Aug' }, lastResultRows: [], lastIntent: null };
    const r = parseAssistantMessage('complete it', ctx, memory);
    expect(r.intent).toBe('project.markCompleted');
    expect(r.entities.projectName).toBe('Concert Aug');
  });

  it('resolves "ledger of same client" via lastEntities.clientName', () => {
    const memory = { lastEntities: { clientName: 'ACME Pvt Ltd' }, lastResultRows: [], lastIntent: null };
    const r = parseAssistantMessage('ledger of same client', ctx, memory);
    expect(r.intent).toBe('client.ledger');
    expect(r.entities.clientName).toBe('ACME Pvt Ltd');
  });

  it('resolves "#2" using lastResultRows', () => {
    const memory = {
      lastEntities: {},
      lastResultRows: [
        { id: 'p1', name: 'Wedding Spectacular', type: 'project' },
        { id: 'p2', name: 'Concert Aug', type: 'project' },
        { id: 'p3', name: 'Done Show', type: 'project' },
      ],
      lastIntent: 'projects.today',
    };
    const r = parseAssistantMessage('open #2', ctx, memory);
    // "open project" keyword maps to projects.details.
    expect(r.intent).toBe('projects.details');
    expect(r.entities.projectName).toBe('Concert Aug');
  });

  it('resolves "the first one" → row index 0', () => {
    const memory = {
      lastEntities: {},
      lastResultRows: [
        { id: 'p1', name: 'Wedding Spectacular', type: 'project' },
        { id: 'p2', name: 'Concert Aug', type: 'project' },
      ],
      lastIntent: 'projects.today',
    };
    const r = parseAssistantMessage('confirm the first one', ctx, memory);
    expect(r.intent).toBe('project.confirm');
    expect(r.entities.projectName).toBe('Wedding Spectacular');
  });

  it('resolves "last" → final row', () => {
    const memory = {
      lastEntities: {},
      lastResultRows: [
        { id: 'p1', name: 'A', type: 'project' },
        { id: 'p2', name: 'B', type: 'project' },
        { id: 'p3', name: 'C', type: 'project' },
      ],
      lastIntent: 'projects.today',
    };
    const r = parseAssistantMessage('confirm last', ctx, memory);
    expect(r.entities.projectName).toBe('C');
  });

  it('row index out of bounds falls through to required-entity error', () => {
    const memory = {
      lastEntities: {},
      lastResultRows: [{ id: 'p1', name: 'A', type: 'project' }],
      lastIntent: 'projects.today',
    };
    const r = parseAssistantMessage('confirm #5', ctx, memory);
    expect(r.intent).toBe('project.confirm');
    expect(r.entities.projectName).toBeUndefined();
    expect(r.issues.some((i) => /project name/i.test(i.message))).toBe(true);
  });

  it('row reference wins over pronoun when both present', () => {
    const memory = {
      lastEntities: { projectName: 'Old Project' },
      lastResultRows: [
        { id: 'p1', name: 'Wedding Spectacular', type: 'project' },
        { id: 'p2', name: 'Concert Aug', type: 'project' },
      ],
      lastIntent: 'projects.today',
    };
    const r = parseAssistantMessage('confirm #1', ctx, memory);
    expect(r.entities.projectName).toBe('Wedding Spectacular');
  });

  it('explicit name in prompt overrides memory', () => {
    const memory = { lastEntities: { projectName: 'Old Project' }, lastResultRows: [], lastIntent: null };
    const r = parseAssistantMessage('confirm project Wedding Spectacular', ctx, memory);
    expect(r.entities.projectName).toBe('Wedding Spectacular');
  });

  it('client row reference for client list intent', () => {
    const memory = {
      lastEntities: {},
      lastResultRows: [
        { id: 'c1', name: 'ACME Pvt Ltd', type: 'client' },
        { id: 'c2', name: 'Beta Events', type: 'client' },
      ],
      lastIntent: 'client.outstanding',
    };
    const r = parseAssistantMessage('ledger of #2', ctx, memory);
    expect(r.intent).toBe('client.ledger');
    expect(r.entities.clientName).toBe('Beta Events');
  });

  it('does not apply memory when no pronoun or row reference is present', () => {
    const memory = { lastEntities: { projectName: 'Old' }, lastResultRows: [], lastIntent: null };
    const r = parseAssistantMessage('today projects', ctx, memory);
    expect(r.intent).toBe('projects.today');
    expect(r.entities.projectName).toBeUndefined();
    expect(r.resolvedFromMemory).toBeUndefined();
  });
});
