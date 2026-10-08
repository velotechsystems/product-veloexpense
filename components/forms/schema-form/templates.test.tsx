import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SchemaForm } from './SchemaForm';

/**
 * The RJSF template layer, driven end-to-end through `<SchemaForm>` rather than by
 * rendering templates in isolation — the branches that matter are chosen by RJSF from
 * the schema shape, so the schema is the honest input.
 *
 * Three rules here are structural and easy to break invisibly:
 *
 *   · **A bounded number auto-promotes to a stepper.** `minimum`/`maximum` on a number
 *     is what makes a field read as a quantity, and the ± buttons follow from that
 *     rather than from a `ui:widget` directive at every call site.
 *   · **The root object and array items render FLAT.** The root's title is the form
 *     heading, not a group legend, and `ArrayFieldTemplate` has already wrapped each
 *     item in its own Fieldset so it could hang the remove button off the legend.
 *     A second Fieldset in either place doubles the chrome — a card inside a card.
 *   · **An empty input reports `emptyValue`, not `''`.** An optional string left blank
 *     must clear rather than write an empty string, or a "not set" field and a field
 *     someone deliberately blanked become indistinguishable in the database.
 */

function form(schema: RJSFSchema, uiSchema?: UiSchema, formData?: unknown) {
  const onSubmit = vi.fn();
  const onChange = vi.fn();
  const utils = render(
    <SchemaForm
      schema={schema}
      uiSchema={uiSchema}
      formData={formData}
      onSubmit={onSubmit}
      onChange={onChange}
    />,
  );
  return { ...utils, onSubmit, onChange };
}

describe('BaseInputTemplate', () => {
  it('renders a plain string as a text input', () => {
    form({ type: 'object', properties: { name: { type: 'string', title: 'Name' } } });
    expect(screen.getByLabelText(/Name/)).toHaveAttribute('type', 'text');
  });

  it('promotes a bounded number to a stepper', () => {
    // `minimum` alone is enough — the field reads as a bounded quantity.
    const { container } = form({
      type: 'object',
      properties: { limit: { type: 'integer', title: 'Limit', minimum: 0, maximum: 10 } },
    });
    const input = container.querySelector('#root_limit') as HTMLInputElement;
    expect(input).toHaveAttribute('min', '0');
    expect(input).toHaveAttribute('max', '10');
    expect(container.querySelectorAll('button').length).toBeGreaterThan(1);
  });

  it('promotes on a maximum alone', () => {
    const { container } = form({
      type: 'object',
      properties: { limit: { type: 'number', title: 'Limit', maximum: 10 } },
    });
    const input = container.querySelector('#root_limit') as HTMLInputElement;
    expect(input).toHaveAttribute('max', '10');
    expect(input).not.toHaveAttribute('min');
  });

  it('leaves an unbounded number as a plain field', () => {
    const { container } = form({
      type: 'object',
      properties: { qty: { type: 'number', title: 'Qty' } },
    });
    const input = container.querySelector('#root_qty') as HTMLInputElement;
    expect(input).not.toHaveAttribute('max');
  });

  it('carries the schema step onto the stepper', () => {
    const { container } = form({
      type: 'object',
      properties: { pct: { type: 'number', title: 'Pct', minimum: 0, multipleOf: 5 } },
    });
    expect(container.querySelector('#root_pct')).toHaveAttribute('step', '5');
  });

  it('shows an existing bounded value', () => {
    const { container } = form(
      { type: 'object', properties: { limit: { type: 'integer', minimum: 0, maximum: 10 } } },
      undefined,
      { limit: 7 },
    );
    expect(container.querySelector('#root_limit')).toHaveValue(7);
  });

  it('leaves a bounded field blank rather than showing zero when unset', () => {
    // Zero is a real limit; "unset" must not look like it.
    const { container } = form({
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 0, maximum: 10 } },
    });
    expect(container.querySelector('#root_limit')).toHaveValue(null);
  });

  it('coerces a typed number to a number, not a string', () => {
    /**
     * RJSF writes back exactly what the widget reports, so a numeric field returning
     * `"12"` fails `type: 'integer'` validation — or, on a schema without strict
     * validation, is stored as a string.
     */
    const { container, onChange } = form({
      type: 'object',
      properties: { qty: { type: 'number', title: 'Qty' } },
    });
    fireEvent.change(container.querySelector('#root_qty') as HTMLElement, {
      target: { value: '12' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ qty: 12 });
  });

  it('never puts NaN into the form data for an unparseable numeric entry', () => {
    /**
     * The template hands the raw string back rather than `Number('1e')`, and RJSF then
     * drops it as invalid for a numeric field — so the property is simply absent. What
     * matters is the negative: NaN must never land in form data, because it serialises
     * to `null` and silently becomes a written value.
     */
    const { container, onChange } = form({
      type: 'object',
      properties: { qty: { type: 'number', title: 'Qty' } },
    });
    fireEvent.change(container.querySelector('#root_qty') as HTMLElement, {
      target: { value: '1e' },
    });
    const last = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(last).toEqual({});
    expect(Number.isNaN(last.qty)).toBe(false);
  });

  it('clears rather than writing an empty string', () => {
    const { container, onChange } = form(
      { type: 'object', properties: { name: { type: 'string', title: 'Name' } } },
      undefined,
      { name: 'Ada' },
    );
    fireEvent.change(container.querySelector('#root_name') as HTMLElement, {
      target: { value: '' },
    });
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('honours an explicit emptyValue', () => {
    const { container, onChange } = form(
      { type: 'object', properties: { name: { type: 'string', title: 'Name' } } },
      { name: { 'ui:emptyValue': '' } },
      { name: 'Ada' },
    );
    fireEvent.change(container.querySelector('#root_name') as HTMLElement, {
      target: { value: '' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ name: '' });
  });

  it('marks a required field on the control', () => {
    form({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', title: 'Name' } },
    });
    expect(screen.getByLabelText(/Name/)).toBeRequired();
  });

  it('disables every control when the form is disabled', () => {
    render(
      <SchemaForm
        schema={{ type: 'object', properties: { name: { type: 'string', title: 'Name' } } }}
        disabled
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/Name/)).toBeDisabled();
  });
});

describe('FieldTemplate', () => {
  it('renders the title as the field label', () => {
    form({ type: 'object', properties: { name: { type: 'string', title: 'Full name' } } });
    expect(screen.getByText(/Full name/)).toBeInTheDocument();
  });

  it('renders a description under the label', () => {
    form({
      type: 'object',
      properties: { name: { type: 'string', title: 'Name', description: 'As on your passport' } },
    });
    expect(screen.getByText('As on your passport')).toBeInTheDocument();
  });

  it('marks required fields in the label', () => {
    form({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', title: 'Name' } },
    });
    expect(screen.getByText('(required)')).toBeInTheDocument();
  });

  it('puts a boolean checkbox before its label', () => {
    // `controlPosition: 'inline-leading'` — "[box] question text" reads as a question
    // the box answers.
    const { container } = form({
      type: 'object',
      properties: { agree: { type: 'boolean', title: 'I agree' } },
    });
    const row = container.querySelector('.flex') as HTMLElement;
    expect(row.textContent).toContain('I agree');
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });
});

describe('ObjectFieldTemplate', () => {
  it('renders the root flat, with no fieldset around it', () => {
    // A card at the top level is visual weight with no purpose.
    const { container } = form({
      title: 'Settings',
      type: 'object',
      properties: { name: { type: 'string', title: 'Name' } },
    });
    expect(container.querySelector('fieldset')).toBeNull();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('wraps a nested object in a fieldset card', () => {
    const { container } = form({
      type: 'object',
      properties: {
        address: {
          type: 'object',
          title: 'Address',
          properties: { city: { type: 'string', title: 'City' } },
        },
      },
    });
    const fieldset = container.querySelector('fieldset');
    expect(fieldset).toBeInTheDocument();
    expect(fieldset?.className).toContain('border-border');
  });

  it('can render a nested object flat when it is only a structural grouping', () => {
    const { container } = form(
      {
        type: 'object',
        properties: {
          address: {
            type: 'object',
            title: 'Address',
            properties: { city: { type: 'string', title: 'City' } },
          },
        },
      },
      // Template options are nested under `ui:options`, not top-level directives.
      { address: { 'ui:options': { fieldset: false } } },
    );
    expect(container.querySelector('fieldset')).toBeNull();
    expect(screen.getByText('Address')).toBeInTheDocument();
  });

  it('takes the flat variant when asked', () => {
    const { container } = form(
      {
        type: 'object',
        properties: {
          address: {
            type: 'object',
            title: 'Address',
            properties: { city: { type: 'string' } },
          },
        },
      },
      { address: { 'ui:options': { variant: 'flat' } } },
    );
    expect(container.querySelector('fieldset')?.className).not.toContain('border-border');
  });

  it('makes a nested object collapsible on request', async () => {
    const { container } = form(
      {
        type: 'object',
        properties: {
          advanced: {
            type: 'object',
            title: 'Advanced',
            properties: { city: { type: 'string', title: 'City' } },
          },
        },
      },
      { advanced: { 'ui:options': { collapsible: true, defaultCollapsed: true } } },
    );
    expect(container.querySelector('#root_advanced_city')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Advanced/ }));
    expect(container.querySelector('#root_advanced_city')).toBeInTheDocument();
  });

  it('shares one label column across inline fields', () => {
    // Inline mode wraps root properties in AlignedFields so the labels line up; a
    // per-field grid would size each row independently.
    const { container } = render(
      <SchemaForm
        inline
        schema={{
          type: 'object',
          properties: {
            a: { type: 'string', title: 'Short' },
            b: { type: 'string', title: 'A much longer label' },
          },
        }}
        onSubmit={vi.fn()}
      />,
    );
    const grid = container.querySelector('.grid') as HTMLElement;
    expect(grid.className).toContain('grid-cols-[auto_minmax(0,1fr)]');
  });
});

describe('ArrayFieldTemplate', () => {
  const arrayOfStrings: RJSFSchema = {
    type: 'object',
    properties: { tags: { type: 'array', title: 'Tags', items: { type: 'string' } } },
  };

  it('offers a way to add the first item', () => {
    form(arrayOfStrings);
    expect(screen.getByRole('button', { name: /Add/ })).toBeInTheDocument();
  });

  it('adds an item', async () => {
    const { container } = form(arrayOfStrings);
    await userEvent.click(screen.getByRole('button', { name: /Add/ }));
    expect(container.querySelector('#root_tags_0')).toBeInTheDocument();
  });

  it('renders a primitive item inline with its own remove control', () => {
    const { container } = form(arrayOfStrings, undefined, { tags: ['a', 'b'] });
    expect(container.querySelector('#root_tags_0')).toBeInTheDocument();
    expect(container.querySelector('#root_tags_1')).toBeInTheDocument();
    // No fieldset for primitives — a card per string is chrome without purpose.
    expect(container.querySelector('fieldset')).toBeNull();
  });

  it('removes the item that was asked for', async () => {
    const { container, onChange } = form(arrayOfStrings, undefined, { tags: ['a', 'b'] });
    const removes = container.querySelectorAll('button[aria-label="Remove"], button[title]');
    // The trash buttons follow each item; click the first one that is not "Add".
    const trash = [...removes].find((b) => !/Add/.test(b.textContent ?? '')) as HTMLElement;
    await userEvent.click(trash);
    expect(onChange).toHaveBeenLastCalledWith({ tags: ['b'] });
  });

  it('wraps an object item in exactly one fieldset', () => {
    /**
     * ArrayFieldTemplate wraps each object item so it can hang the remove button off
     * the legend, and ArrayItemContext then tells the inner ObjectFieldTemplate to
     * render flat. Without that signal each item gets a card inside a card.
     */
    const { container } = form(
      {
        type: 'object',
        properties: {
          people: {
            type: 'array',
            title: 'People',
            items: { type: 'object', properties: { name: { type: 'string', title: 'Name' } } },
          },
        },
      },
      undefined,
      { people: [{ name: 'Ada' }] },
    );
    expect(container.querySelectorAll('fieldset')).toHaveLength(1);
  });

  it('renders nothing but the add button for an empty array', () => {
    const { container } = form(arrayOfStrings, undefined, { tags: [] });
    expect(container.querySelector('#root_tags_0')).toBeNull();
    expect(screen.getByRole('button', { name: /Add/ })).toBeInTheDocument();
  });

  it('hides the add button when the schema forbids more', () => {
    form(
      {
        type: 'object',
        properties: {
          tags: { type: 'array', title: 'Tags', items: { type: 'string' }, maxItems: 1 },
        },
      },
      undefined,
      { tags: ['a'] },
    );
    expect(screen.queryByRole('button', { name: /^Add$/ })).not.toBeInTheDocument();
  });
});

describe('submission', () => {
  it('renders a default submit button', () => {
    form({ type: 'object', properties: { name: { type: 'string' } } });
    expect(screen.getByRole('button', { name: /Submit|Save/i })).toBeInTheDocument();
  });

  it('lets a caller replace it', () => {
    render(
      <SchemaForm
        schema={{ type: 'object', properties: { name: { type: 'string' } } }}
        onSubmit={vi.fn()}
      >
        <button type="submit">Save changes</button>
      </SchemaForm>,
    );
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Submit$/ })).not.toBeInTheDocument();
  });

  it('reports the form data on submit', async () => {
    const { onSubmit } = form(
      { type: 'object', properties: { name: { type: 'string', title: 'Name' } } },
      undefined,
      { name: 'Ada' },
    );
    await userEvent.click(screen.getByRole('button', { name: /Submit|Save/i }));
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Ada' });
  });

  it('withholds submit while a required field is empty', async () => {
    const { onSubmit } = form({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', title: 'Name' } },
    });
    await userEvent.click(screen.getByRole('button', { name: /Submit|Save/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
