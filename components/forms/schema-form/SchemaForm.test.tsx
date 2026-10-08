import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SchemaForm } from '.';

const SCHEMA: RJSFSchema = {
  type: 'object',
  required: ['clientId'],
  properties: {
    clientId: { type: 'string', title: 'Client ID' },
    clientSecret: { type: 'string', title: 'Client Secret' },
    directoryDisabled: { type: 'boolean', title: 'Disable directory sync' },
    allowedDomains: { type: 'array', title: 'Allowed Domains', items: { type: 'string' } },
  },
};

const UI: UiSchema = { clientSecret: { 'ui:widget': 'password' } };

describe('SchemaForm', () => {
  it('renders design-system controls for each schema field', () => {
    render(<SchemaForm schema={SCHEMA} uiSchema={UI} onSubmit={() => {}} />);

    // Labels from the field template.
    expect(screen.getByText('Client ID')).toBeInTheDocument();
    expect(screen.getByText('Disable directory sync')).toBeInTheDocument();

    // Password widget renders a password input.
    const secret = document.querySelector('input[type="password"]');
    expect(secret).not.toBeNull();

    // Array field exposes an Add control.
    expect(screen.getByRole('button', { name: /add/i })).toBeInTheDocument();
  });

  it('blocks submission and reports an error when a required field is empty', async () => {
    const onSubmit = vi.fn();
    render(
      <SchemaForm schema={SCHEMA} uiSchema={UI} onSubmit={onSubmit}>
        <button type="submit">Save</button>
      </SchemaForm>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSubmit).not.toHaveBeenCalled();
    // Match the validation error specifically — "(required)" markers also
    // contain "required", so assert on the ajv message text.
    expect(await screen.findByText(/must have required property/i)).toBeInTheDocument();
  });

  it('submits the form data when validation passes', async () => {
    const onSubmit = vi.fn();
    render(
      <SchemaForm schema={SCHEMA} uiSchema={UI} onSubmit={onSubmit}>
        <button type="submit">Save</button>
      </SchemaForm>,
    );

    // The first textbox is clientId (the required field).
    const inputs = screen.getAllByRole('textbox');
    await userEvent.type(inputs[0] as HTMLElement, 'abc-123');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ clientId: 'abc-123' });
  });
});
