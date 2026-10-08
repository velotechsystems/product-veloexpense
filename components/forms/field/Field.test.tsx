import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AlignedFields, Field } from './Field';

/**
 * The single canonical field anatomy — both the RJSF templates and every hand-built form
 * render through it, so a regression here is a regression everywhere at once.
 *
 * Two of its rules are the kind that look like styling and are not. The help "?" is
 * suppressed in stacked layout unless there is also a description for it to elaborate on,
 * which means a caller who sets only `tooltip` gets no icon — deliberate, and easy for a
 * later refactor to "fix" into an always-on icon. And in inline layout the description
 * stops being static text and becomes a hover tooltip on the label, leaving the control
 * cell unwrapped so a control's own per-option tooltips keep their hover region.
 */

describe('label and markers', () => {
  it('associates the label with the control', () => {
    render(
      <Field htmlFor="amount" label="Amount">
        <input id="amount" />
      </Field>,
    );
    expect(screen.getByLabelText('Amount')).toBe(screen.getByRole('textbox'));
  });

  it('marks required', () => {
    render(
      <Field htmlFor="a" label="Amount" required>
        <input id="a" />
      </Field>,
    );
    expect(screen.getByText('(required)')).toBeInTheDocument();
  });

  it('marks optional', () => {
    render(
      <Field htmlFor="a" label="Memo" optional>
        <input id="a" />
      </Field>,
    );
    expect(screen.getByText('(optional)')).toBeInTheDocument();
  });

  it('prefers required when both markers are passed', () => {
    // They are documented as mutually exclusive; required is the safer of the two to win,
    // since showing "(optional)" on a field that blocks submit is the worse failure.
    render(
      <Field htmlFor="a" label="Amount" required optional>
        <input id="a" />
      </Field>,
    );
    expect(screen.getByText('(required)')).toBeInTheDocument();
    expect(screen.queryByText('(optional)')).not.toBeInTheDocument();
  });

  it('hides the visible label on request but keeps the control', () => {
    // Booleans and array items render their label elsewhere.
    render(
      <Field htmlFor="a" label="Reimbursable" hideLabel>
        <input id="a" type="checkbox" />
      </Field>,
    );
    expect(screen.queryByText('Reimbursable')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });
});

describe('the help "?" icon', () => {
  it('appears when there is a description to elaborate on', () => {
    render(
      <Field htmlFor="a" label="Amount" description="Before tax" tooltip="Long explanation">
        <input id="a" />
      </Field>,
    );
    expect(screen.getByLabelText('More information')).toBeInTheDocument();
  });

  it('stays hidden when a tooltip is set with no description', () => {
    // The documented rule: the tooltip layers on the description, so without one the
    // affordance has nothing to elaborate and is suppressed.
    render(
      <Field htmlFor="a" label="Amount" tooltip="Long explanation">
        <input id="a" />
      </Field>,
    );
    expect(screen.queryByLabelText('More information')).not.toBeInTheDocument();
  });

  it('renders in inline layout from the tooltip alone', () => {
    // Inline layout is the exception — there the description became a label tooltip, so
    // the "?" is the only remaining place help can live and it renders unconditionally.
    render(
      <Field htmlFor="a" label="Amount" inline tooltip="Long explanation">
        <input id="a" />
      </Field>,
    );
    expect(screen.getByLabelText('More information')).toBeInTheDocument();
  });
});

describe('errors and hints', () => {
  it('renders one line per error', () => {
    render(
      <Field htmlFor="a" label="Amount" errors={['Must be positive', 'Required']}>
        <input id="a" />
      </Field>,
    );
    expect(screen.getByRole('list').children).toHaveLength(2);
  });

  it('renders nothing for an empty error list', () => {
    const { container } = render(
      <Field htmlFor="a" label="Amount" errors={[]}>
        <input id="a" />
      </Field>,
    );
    expect(container.querySelector('ul')).toBeNull();
  });

  it('renders a hint with its optional heading', () => {
    render(
      <Field htmlFor="a" label="Password" hintLabel="Requirements:" hint={<p>12+ characters</p>}>
        <input id="a" />
      </Field>,
    );
    expect(screen.getByText('Requirements:')).toBeInTheDocument();
    expect(screen.getByText('12+ characters')).toBeInTheDocument();
  });

  it('renders a hint with no heading', () => {
    render(
      <Field htmlFor="a" label="Password" hint={<p>12+ characters</p>}>
        <input id="a" />
      </Field>,
    );
    expect(screen.getByText('12+ characters')).toBeInTheDocument();
  });
});

describe('inline layout', () => {
  it('turns the description into a label tooltip instead of static text', () => {
    // The description must NOT render as visible text in inline mode — it is only
    // reachable by hovering the label, so the row keeps a single-line height.
    render(
      <Field htmlFor="a" label="Amount" inline description="Before tax">
        <input id="a" />
      </Field>,
    );
    expect(screen.queryByText('Before tax')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toBeInTheDocument();
  });

  it('still renders errors and hints below the control', () => {
    render(
      <Field htmlFor="a" label="Amount" inline errors={['Required']} hint={<p>Tip</p>}>
        <input id="a" />
      </Field>,
    );
    expect(screen.getByText('Required')).toBeInTheDocument();
    expect(screen.getByText('Tip')).toBeInTheDocument();
  });

  it('renders a placeholder cell when the label is hidden so the columns still line up', () => {
    const { container } = render(
      <Field htmlFor="a" label="Amount" inline hideLabel>
        <input id="a" />
      </Field>,
    );
    expect(container.querySelector('span')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('owns its own grid when standalone', () => {
    const { container } = render(
      <Field htmlFor="a" label="Amount" inline>
        <input id="a" />
      </Field>,
    );
    expect(container.firstElementChild?.className).toContain('grid');
  });

  it('defers to the parent grid inside AlignedFields', () => {
    /**
     * The alignment contract: inside the wrapper the Field renders a fragment, so its
     * label and control land as direct children of the parent grid and share one label
     * column with its siblings. Wrapping itself in a nested grid here is exactly what
     * breaks the shared gutter.
     */
    const { container } = render(
      <AlignedFields>
        <Field htmlFor="a" label="Short" inline>
          <input id="a" />
        </Field>
        <Field htmlFor="b" label="A much longer label" inline>
          <input id="b" />
        </Field>
      </AlignedFields>,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toContain('grid');
    // Four direct children — two label cells and two control cells — not two nested grids.
    expect(grid.children).toHaveLength(4);
  });
});

describe('leading-control layout', () => {
  it('puts the control before the label text', () => {
    const { container } = render(
      <Field htmlFor="a" label="Reimbursable" controlPosition="inline-leading">
        <input id="a" type="checkbox" />
      </Field>,
    );
    const row = container.querySelector('.flex') as HTMLElement;
    expect(row.firstElementChild?.tagName).toBe('INPUT');
  });

  it('keeps description, errors and hints below the row', () => {
    render(
      <Field
        htmlFor="a"
        label="Reimbursable"
        controlPosition="inline-leading"
        description="Counts toward the report total"
        tooltip="More"
        errors={['Pick one']}
        hint={<p>Note</p>}
      >
        <input id="a" type="checkbox" />
      </Field>,
    );
    expect(screen.getByText('Counts toward the report total')).toBeInTheDocument();
    expect(screen.getByText('Pick one')).toBeInTheDocument();
    expect(screen.getByText('Note')).toBeInTheDocument();
    expect(screen.getByLabelText('More information')).toBeInTheDocument();
  });

  it('renders with no label at all', () => {
    render(
      <Field controlPosition="inline-leading">
        <input aria-label="bare" type="checkbox" />
      </Field>,
    );
    expect(screen.getByLabelText('bare')).toBeInTheDocument();
  });
});
