import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  buildDeterminationParams,
  buildDeterminationSchema,
  DOCUMENT_KINDS,
  parseDeterminationMessage,
} from './determination';
import { ExtractionRefusedError } from './extract';

const doc = (documentId: string, filename = `${documentId}.jpg`) => ({
  documentId,
  filename,
  data: new Uint8Array([1, 2, 3]),
  mimeType: 'image/jpeg',
});

describe('buildDeterminationSchema', () => {
  it('constrains each verdict to the ids actually sent', () => {
    const schema = buildDeterminationSchema(['r1', 'r2']) as never as {
      properties: { documents: { items: { properties: { documentId: { enum: string[] } } } } };
    };
    // A verdict that can't be matched back to a row is a verdict we can't store.
    expect(schema.properties.documents.items.properties.documentId.enum).toEqual(['r1', 'r2']);
  });

  it('constrains the kind to the schema enum', () => {
    const schema = buildDeterminationSchema(['r1']) as never as {
      properties: { documents: { items: { properties: { kind: { enum: string[] } } } } };
    };
    expect(schema.properties.documents.items.properties.kind.enum).toEqual([...DOCUMENT_KINDS]);
  });

  it('constrains categories to the real codes, plus null', () => {
    const schema = buildDeterminationSchema(['r1'], ['cat-meals']) as never as {
      properties: { derivedCategoryCode: { enum: (string | null)[] } };
    };
    // The model must not be able to invent a category id.
    expect(schema.properties.derivedCategoryCode.enum).toEqual(['cat-meals', null]);
  });

  it('leaves the category a free nullable string when no vocabulary is given', () => {
    const schema = buildDeterminationSchema(['r1']) as never as {
      properties: { derivedCategoryCode: { type: string[]; enum?: unknown } };
    };
    expect(schema.properties.derivedCategoryCode.enum).toBeUndefined();
    expect(schema.properties.derivedCategoryCode.type).toEqual(['string', 'null']);
  });

  it('requires every field, so a partial object never validates', () => {
    const schema = buildDeterminationSchema(['r1']) as never as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
  });
});

describe('buildDeterminationParams', () => {
  const params = () =>
    buildDeterminationParams({
      documents: [doc('r1'), doc('r2', 'card-copy.pdf')],
      categoryHints: [{ code: 'cat-meals', label: 'Meals' }],
      model: 'claude-sonnet-5',
    });

  it('sends EVERY document in ONE request', () => {
    const content = params().messages[0].content as Anthropic.ContentBlockParam[];
    const images = content.filter((b) => b.type === 'image' || b.type === 'document');
    // Reading them one at a time and merging is what double-counts a charge.
    expect(images).toHaveLength(2);
  });

  it('labels each document with the id its verdict must come back under', () => {
    const content = params().messages[0].content as Anthropic.ContentBlockParam[];
    const text = content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n');
    expect(text).toContain('Document r1');
    expect(text).toContain('Document r2');
    expect(text).toContain('card-copy.pdf');
  });

  it('forces the structured tool call', () => {
    const p = params();
    expect(p.tool_choice).toEqual({ type: 'tool', name: 'record_determination' });
    expect(p.tools?.[0].name).toBe('record_determination');
  });

  it('injects prior human corrections as authoritative', () => {
    const p = buildDeterminationParams({
      documents: [doc('r1')],
      overrides: [{ field: 'total', value: '130.00' }],
      model: 'claude-sonnet-5',
    });
    const text = (p.messages[0].content as Anthropic.ContentBlockParam[])
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n');
    expect(text).toContain('total: 130.00');
    expect(text).toContain('authoritative');
  });

  it('says nothing about corrections when there are none', () => {
    const text = (params().messages[0].content as Anthropic.ContentBlockParam[])
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n');
    expect(text).not.toContain('authoritative');
  });

  it('tells the model never to add totals across documents', () => {
    // The single most expensive mistake this pass can make.
    expect(params().system).toContain('NEVER add totals across documents');
  });

  it('sends a PDF as a document block, not an image', () => {
    const p = buildDeterminationParams({
      documents: [{ ...doc('r1'), mimeType: 'application/pdf' }],
      model: 'claude-sonnet-5',
    });
    const content = p.messages[0].content as Anthropic.ContentBlockParam[];
    expect(content.some((b) => b.type === 'document')).toBe(true);
  });

  it('rejects a document type the model cannot read', () => {
    expect(() =>
      buildDeterminationParams({
        documents: [{ ...doc('r1'), mimeType: 'application/zip' }],
        model: 'claude-sonnet-5',
      }),
    ).toThrow(/Unsupported document type/);
  });
});

describe('parseDeterminationMessage', () => {
  it('returns the tool input and its confidence', () => {
    const out = parseDeterminationMessage({
      content: [
        { type: 'tool_use', id: 't1', name: 'record_determination', input: { confidence: 0.87 } },
      ],
    } as never);
    expect(out.confidence).toBe(0.87);
  });

  it('throws when the model returned no tool call', () => {
    expect(() =>
      parseDeterminationMessage({ content: [{ type: 'text', text: 'no' }] } as never),
    ).toThrow(ExtractionRefusedError);
  });

  it('reports a null confidence rather than inventing one', () => {
    const out = parseDeterminationMessage({
      content: [{ type: 'tool_use', id: 't1', name: 'record_determination', input: {} }],
    } as never);
    expect(out.confidence).toBeNull();
  });
});
