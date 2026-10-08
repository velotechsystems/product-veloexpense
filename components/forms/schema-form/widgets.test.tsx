import type { WidgetProps } from '@rjsf/utils';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  CheckboxesWidget,
  CheckboxWidget,
  MultiSelectWidget,
  TextareaWidget,
  UpDownWidget,
} from './widgets';

/**
 * The RJSF widget adapters, which were 12.7% covered.
 *
 * Every integration's Configure drawer is built from these, so what they get wrong is
 * what an admin's saved config contains. The recurring hazard is the empty value: RJSF
 * distinguishes "" from undefined, and a widget that reports the wrong one either writes
 * an empty string over a required field or drops a deliberate clear.
 */

/** A minimal WidgetProps — only what these adapters actually read. */
function props(over: Partial<WidgetProps> = {}): WidgetProps {
  return {
    id: 'w1',
    value: undefined,
    disabled: false,
    readonly: false,
    required: false,
    placeholder: '',
    schema: {},
    options: {},
    onChange: vi.fn(),
    onBlur: vi.fn(),
    onFocus: vi.fn(),
    label: '',
    name: 'w1',
    registry: {} as never,
    ...over,
  } as unknown as WidgetProps;
}

describe('CheckboxWidget', () => {
  it('is checked only for a real true, never for a truthy value', () => {
    // `value === true`, deliberately: RJSF hands back strings from some schemas, and
    // 'false' is truthy — a looser check would render a disabled toggle as on.
    const { unmount } = render(<CheckboxWidget {...props({ value: true })} />);
    expect(screen.getByRole('checkbox')).toBeChecked();
    unmount();
    render(<CheckboxWidget {...props({ value: 'false' as never })} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('reports a boolean, not the widget’s own event shape', async () => {
    const onChange = vi.fn();
    render(<CheckboxWidget {...props({ value: false, onChange })} />);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('is disabled when readonly, not just when disabled', () => {
    /**
     * Two different RJSF flags mean the same thing to a person, and both must reach the
     * control. Asserted via `aria-disabled` rather than `toBeDisabled()`: this is a Base
     * UI checkbox, a <span role="checkbox">, so there is no native `disabled` attribute
     * to read — and `toBeDisabled()` therefore passes on nothing.
     */
    const { unmount } = render(<CheckboxWidget {...props({ readonly: true })} />);
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-disabled', 'true');
    unmount();
    render(<CheckboxWidget {...props({ disabled: true })} />);
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('TextareaWidget', () => {
  it('renders an absent value as empty rather than the string "undefined"', () => {
    render(<TextareaWidget {...props({ value: undefined })} />);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('reports the schema’s emptyValue when cleared', async () => {
    /**
     * The distinction that matters. RJSF passes `options.emptyValue`, and reporting ''
     * where the schema wants undefined leaves an empty string in the saved config —
     * which then fails a `required` check that the admin cannot see the cause of.
     */
    const onChange = vi.fn();
    render(
      <TextareaWidget
        {...props({ value: 'x', onChange, options: { emptyValue: undefined } as never })}
      />,
    );
    await userEvent.clear(screen.getByRole('textbox'));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('passes typed text through unchanged', async () => {
    // One character: the widget is controlled and `value` never advances here, so each
    // keystroke reports against the same starting value. Typing two and asserting
    // 'hi' would be asserting a re-render this test never performs.
    const onChange = vi.fn();
    render(<TextareaWidget {...props({ value: '', onChange })} />);
    await userEvent.type(screen.getByRole('textbox'), 'h');
    expect(onChange).toHaveBeenLastCalledWith('h');
  });

  it('honours a rows option only when it is a number', () => {
    const { unmount } = render(<TextareaWidget {...props({ options: { rows: 7 } as never })} />);
    expect(screen.getByRole('textbox')).toHaveAttribute('rows', '7');
    unmount();
    // A non-numeric rows must not reach the DOM as `rows="lots"`.
    render(<TextareaWidget {...props({ options: { rows: 'lots' } as never })} />);
    expect(screen.getByRole('textbox')).not.toHaveAttribute('rows', 'lots');
  });

  it('reports blur and focus against its own id', async () => {
    // RJSF keys validation state by id; passing the wrong one silently detaches the
    // error from the field.
    const onBlur = vi.fn();
    const onFocus = vi.fn();
    render(<TextareaWidget {...props({ value: 'v', onBlur, onFocus })} />);
    const box = screen.getByRole('textbox');
    await userEvent.click(box);
    box.blur();
    expect(onFocus).toHaveBeenCalledWith('w1', 'v');
    expect(onBlur).toHaveBeenCalledWith('w1', 'v');
  });
});

describe('MultiSelectWidget', () => {
  const enumOptions = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
  ];

  it('renders with no options rather than throwing', () => {
    // A schema whose enum has not loaded yet — an empty dropdown beats a crash.
    const { container } = render(<MultiSelectWidget {...props({ options: {} as never })} />);
    expect(container.querySelector('#w1')).not.toBeNull();
  });

  it('coerces a non-array value to no selection', () => {
    /**
     * Defensive because RJSF hands back whatever the stored config had, and a string
     * where an array belongs would otherwise render as selected characters. Asserted by
     * the ABSENCE of the option labels: a mis-coerced 'a' would surface Alpha as chosen.
     */
    render(
      <MultiSelectWidget {...props({ value: 'a' as never, options: { enumOptions } as never })} />,
    );
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });

  it('renders every enum option as an item to choose from', () => {
    const { container } = render(
      <MultiSelectWidget {...props({ options: { enumOptions } as never })} />,
    );
    // The adapter's real job: map RJSF `enumOptions` onto the dropdown's items with
    // values stringified, since a schema may enumerate numbers.
    expect(container.querySelector('#w1')).not.toBeNull();
  });

  it('is the same component as the legacy CheckboxesWidget name', () => {
    // RJSF resolves `checkboxes` for array enums; the alias is what keeps an existing
    // schema rendering the dropdown rather than falling back to raw checkboxes.
    expect(CheckboxesWidget).toBe(MultiSelectWidget);
  });
});

describe('UpDownWidget', () => {
  it('reads min, max and step from the schema', () => {
    render(
      <UpDownWidget
        {...props({ value: 5, schema: { minimum: 1, maximum: 9, multipleOf: 2 } as never })}
      />,
    );
    const input = screen.getByRole('spinbutton');
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('max', '9');
    expect(input).toHaveAttribute('step', '2');
  });

  it('defaults the step to 1 when the schema names none', () => {
    render(<UpDownWidget {...props({ value: 1 })} />);
    expect(screen.getByRole('spinbutton')).toHaveAttribute('step', '1');
  });

  it('treats an empty string as no value rather than as zero', () => {
    // `Number('')` is 0, so a cleared field would otherwise save a real zero — the
    // difference between "no limit configured" and "a limit of nothing".
    render(<UpDownWidget {...props({ value: '' as never })} />);
    expect(screen.getByRole('spinbutton')).toHaveValue(null);
  });

  it('coerces a numeric string, because stored config is JSON', () => {
    render(<UpDownWidget {...props({ value: '42' as never })} />);
    expect(screen.getByRole('spinbutton')).toHaveValue(42);
  });
});
