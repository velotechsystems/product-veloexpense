import type { WidgetProps } from '@rjsf/utils';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ColorWidget,
  ExternalIdsWidget,
  RadioWidget,
  RangeWidget,
  SelectWidget,
  UpDownWidget,
} from './widgets';

/**
 * The RJSF widget adapters' VALUE COERCION.
 *
 * Every widget here sits between a JSON-schema value and a component with a narrower
 * idea of what a value is, and each translation is a place a type can quietly change
 * on the way through. That is the whole failure mode: RJSF hands the schema layer back
 * whatever the widget reports, so a numeric enum that returns as `"3"` validates
 * against `type: 'integer'` and fails — or worse, is written to the database as a
 * string by a schema without strict validation.
 *
 * `widgets.test.tsx` covers rendering; this covers what comes back out.
 */

function props(over: Partial<WidgetProps> = {}): WidgetProps {
  return {
    id: 'w1',
    name: 'w1',
    value: undefined,
    required: false,
    disabled: false,
    readonly: false,
    autofocus: false,
    label: 'Field',
    schema: {},
    uiSchema: {},
    options: {},
    formContext: {},
    onChange: vi.fn(),
    onBlur: vi.fn(),
    onFocus: vi.fn(),
    registry: {} as never,
    ...over,
  } as WidgetProps;
}

describe('SelectWidget', () => {
  const numericOptions = {
    enumOptions: [
      { value: 1, label: 'One' },
      { value: 2, label: 'Two' },
    ],
  };

  it('renders the option labels', () => {
    render(<SelectWidget {...props({ options: numericOptions, value: 1 })} />);
    // The Combobox is string-keyed, so a numeric value must still resolve its label.
    expect(screen.getByDisplayValue('One')).toBeInTheDocument();
  });

  it('shows a placeholder when nothing is selected', () => {
    render(<SelectWidget {...props({ options: numericOptions, placeholder: 'Pick one' })} />);
    expect(screen.getByPlaceholderText('Pick one')).toBeInTheDocument();
  });

  it('falls back to a default placeholder', () => {
    render(<SelectWidget {...props({ options: numericOptions })} />);
    expect(screen.getByPlaceholderText('Select…')).toBeInTheDocument();
  });

  it('renders with no options at all', () => {
    // A facet-backed enum can arrive empty before its query resolves.
    render(<SelectWidget {...props({ options: {} })} />);
    expect(screen.getByPlaceholderText('Select…')).toBeInTheDocument();
  });

  it('is disabled when the field is read-only', () => {
    // `readonly` and `disabled` must both reach the control, or a read-only form is
    // editable.
    render(<SelectWidget {...props({ options: numericOptions, readonly: true })} />);
    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});

describe('RadioWidget', () => {
  const plain = {
    enumOptions: [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ],
  };
  const described = {
    enumOptions: [
      { value: 'a', label: 'Alpha', schema: { description: 'The first one' } },
      { value: 'b', label: 'Beta' },
    ],
  };

  it('renders one radio per option, labelled', () => {
    render(<RadioWidget {...props({ options: plain })} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('surfaces a per-option description from the oneOf branch', () => {
    // RJSF mirrors a `oneOf` branch's description onto the option's schema; without
    // reading it, a documented choice renders as a bare label.
    render(<RadioWidget {...props({ options: described })} />);
    expect(screen.getByText('The first one')).toBeInTheDocument();
  });

  it('gives described groups room to breathe', () => {
    const { container } = render(<RadioWidget {...props({ options: described })} />);
    expect(container.firstElementChild?.className).toContain('space-y-2');
  });

  it('keeps undescribed groups tight', () => {
    const { container } = render(<RadioWidget {...props({ options: plain })} />);
    expect(container.firstElementChild?.className ?? '').not.toContain('space-y-2');
  });

  it('renders as a single radio group', () => {
    // Base UI does not reflect `orientation` into an attribute in this version, so the
    // inline/vertical distinction is only observable through the spacing class below.
    const { container } = render(<RadioWidget {...props({ options: plain })} />);
    expect(container.querySelectorAll('[role="radiogroup"]')).toHaveLength(1);
  });

  it('drops the inline spacing class even when inline options carry descriptions', () => {
    const { container } = render(
      <RadioWidget {...props({ options: { ...described, inline: true } })} />,
    );
    expect(container.firstElementChild?.className ?? '').not.toContain('space-y-2');
  });

  it('associates each label with its own radio', () => {
    /**
     * Distinct ids per option; a shared id makes every label select the first radio.
     * The id lands on the hidden `input[type=radio]` — Base UI's visible `role="radio"`
     * span carries its own generated id — and `<label for>` points at the input, so the
     * input is what has to be unique.
     */
    const { container } = render(<RadioWidget {...props({ options: plain, id: 'kind' })} />);
    const inputs = [...container.querySelectorAll('input[type="radio"]')] as HTMLInputElement[];
    expect(inputs.map((i) => i.id)).toEqual(['kind-a', 'kind-b']);
    const labels = [...container.querySelectorAll('label')] as HTMLLabelElement[];
    expect(labels.map((l) => l.getAttribute('for'))).toEqual(['kind-a', 'kind-b']);
  });

  it('disables every option when read-only', () => {
    render(<RadioWidget {...props({ options: plain, readonly: true })} />);
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toHaveAttribute('aria-disabled', 'true');
    }
  });
});

describe('ColorWidget', () => {
  /**
   * Read the TEXT field, not the swatch. A native `input[type=color]` has no empty
   * state — it reports `#000000` whatever you give it — so the swatch cannot
   * distinguish "unset" from "black". The text field is where an unset colour shows.
   */
  const textField = (c: HTMLElement) =>
    c.querySelector('input[aria-label="Color value"]') as HTMLInputElement;

  it('turns a null value into an empty string', () => {
    // A null reaching a controlled input makes React fall back to uncontrolled, and
    // the field then silently stops tracking the form.
    const { container } = render(<ColorWidget {...props({ value: null })} />);
    expect(textField(container).value).toBe('');
  });

  it('passes a real colour through', () => {
    const { container } = render(<ColorWidget {...props({ value: '#b91c1c' })} />);
    expect(container.querySelector('input[type="color"]')).toHaveValue('#b91c1c');
  });
});

/**
 * Base UI's Slider paints divs for the track and thumb and puts the real control in a
 * hidden `input[type=range]`; the visible wrapper is `role="group"`, so there is no
 * `role="slider"` to query. The input is what carries min/max/step and the value.
 */
const rangeInputs = (c: HTMLElement) =>
  [...c.querySelectorAll('input[type="range"]')] as HTMLInputElement[];

describe('RangeWidget — scalar', () => {
  it('reads its bounds and step from the schema', () => {
    const { container } = render(
      <RangeWidget
        {...props({ schema: { minimum: 10, maximum: 20, multipleOf: 2 }, value: 12 })}
      />,
    );
    const [input] = rangeInputs(container);
    expect(input).toHaveAttribute('min', '10');
    expect(input).toHaveAttribute('max', '20');
    expect(input).toHaveAttribute('step', '2');
    expect(input).toHaveAttribute('aria-valuenow', '12');
  });

  it('defaults to 0–100 with a step of 1', () => {
    const { container } = render(<RangeWidget {...props({ value: 50 })} />);
    const [input] = rangeInputs(container);
    expect(input).toHaveAttribute('min', '0');
    expect(input).toHaveAttribute('max', '100');
    expect(input).toHaveAttribute('step', '1');
  });

  it('shows the live value beside the track', () => {
    render(<RangeWidget {...props({ value: 42 })} />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('falls back to the minimum for a non-numeric value', () => {
    /**
     * A slider handed NaN renders a thumb at an undefined position and reports NaN
     * back into the form. Clamping to the minimum keeps the control usable and the
     * value valid.
     */
    const { container } = render(
      <RangeWidget {...props({ schema: { minimum: 5 }, value: 'not a number' })} />,
    );
    expect(rangeInputs(container)[0]).toHaveAttribute('aria-valuenow', '5');
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('falls back to the minimum for an absent value', () => {
    const { container } = render(
      <RangeWidget {...props({ schema: { minimum: 7 }, value: undefined })} />,
    );
    expect(rangeInputs(container)[0]).toHaveAttribute('aria-valuenow', '7');
  });

  it('coerces a numeric string', () => {
    const { container } = render(<RangeWidget {...props({ value: '30' })} />);
    expect(rangeInputs(container)[0]).toHaveAttribute('aria-valuenow', '30');
  });

  it('labels itself from the schema title', () => {
    const { container } = render(
      <RangeWidget {...props({ schema: { title: 'Threshold' }, value: 1 })} />,
    );
    expect(rangeInputs(container)[0]).toHaveAttribute('aria-label', 'Threshold');
  });

  it('falls back to a generic label', () => {
    const { container } = render(<RangeWidget {...props({ value: 1 })} />);
    expect(rangeInputs(container)[0]).toHaveAttribute('aria-label', 'Value');
  });
});

describe('RangeWidget — between', () => {
  const tupleSchema = { type: 'array' as const, minimum: 0, maximum: 100 };

  it('renders two thumbs with distinct labels', () => {
    const { container } = render(
      <RangeWidget {...props({ schema: tupleSchema, value: [20, 80] })} />,
    );
    expect(rangeInputs(container).map((i) => i.getAttribute('aria-label'))).toEqual([
      'Lower bound',
      'Upper bound',
    ]);
  });

  it('shows both ends of the range', () => {
    render(<RangeWidget {...props({ schema: tupleSchema, value: [20, 80] })} />);
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
  });

  it('spans the full range when no value is set', () => {
    // An unset "between" filter should read as "everything", not as a zero-width band.
    const { container } = render(
      <RangeWidget {...props({ schema: tupleSchema, value: undefined })} />,
    );
    expect(rangeInputs(container).map((i) => i.getAttribute('aria-valuenow'))).toEqual([
      '0',
      '100',
    ]);
  });

  it('repairs each end independently', () => {
    // A half-written tuple keeps the good half rather than resetting both.
    const { container } = render(
      <RangeWidget {...props({ schema: tupleSchema, value: ['x', 60] })} />,
    );
    expect(rangeInputs(container).map((i) => i.getAttribute('aria-valuenow'))).toEqual(['0', '60']);
  });

  it('coerces numeric strings in the tuple', () => {
    render(<RangeWidget {...props({ schema: tupleSchema, value: ['20', '80'] })} />);
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
  });
});

describe('UpDownWidget', () => {
  const findInput = (c: HTMLElement) => c.querySelector('input') as HTMLInputElement;

  it('passes a number straight through', () => {
    const { container } = render(<UpDownWidget {...props({ value: 12 })} />);
    expect(findInput(container).value).toBe('12');
  });

  it('treats an empty string as no value, not as zero', () => {
    /**
     * The distinction that matters on an optional numeric field: coercing `''` to 0
     * writes a real zero into the form, and a zero limit is not the same as an unset
     * one — one blocks every transaction, the other blocks none.
     */
    const { container } = render(<UpDownWidget {...props({ value: '' })} />);
    expect(findInput(container).value).toBe('');
  });

  it('treats null and undefined as no value', () => {
    for (const empty of [null, undefined]) {
      const { container, unmount } = render(<UpDownWidget {...props({ value: empty })} />);
      expect(findInput(container).value).toBe('');
      unmount();
    }
  });

  it('coerces a numeric string', () => {
    const { container } = render(<UpDownWidget {...props({ value: '25' })} />);
    expect(findInput(container).value).toBe('25');
  });

  it('carries the schema bounds onto the control', () => {
    const { container } = render(
      <UpDownWidget {...props({ schema: { minimum: 1, maximum: 9 }, value: 5 })} />,
    );
    const input = findInput(container);
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('max', '9');
  });

  it('leaves the bounds off when the schema sets none', () => {
    // An absent bound must not become 0 — that would forbid negative values.
    const { container } = render(<UpDownWidget {...props({ value: 5 })} />);
    const input = findInput(container);
    expect(input).not.toHaveAttribute('min');
    expect(input).not.toHaveAttribute('max');
  });

  it('is disabled when read-only', () => {
    const { container } = render(<UpDownWidget {...props({ value: 5, readonly: true })} />);
    expect(findInput(container)).toBeDisabled();
  });

  it('marks the control required', () => {
    const { container } = render(<UpDownWidget {...props({ value: 5, required: true })} />);
    expect(findInput(container)).toBeRequired();
  });
});

describe('ExternalIdsWidget', () => {
  it('treats a non-object value as an empty map', () => {
    /**
     * The stored column is Jsonb, so anything can be in it — a string from a bad
     * migration, an array from an older shape. Iterating that as a map throws and takes
     * the whole admin form down; an empty editor is recoverable.
     */
    for (const bad of [null, undefined, 'oops', 42, ['a']]) {
      const { unmount } = render(<ExternalIdsWidget {...props({ value: bad })} />);
      unmount();
    }
    // Reaching here without throwing is the assertion.
    expect(true).toBe(true);
  });

  it('renders the stored pairs', () => {
    render(<ExternalIdsWidget {...props({ value: { netsuite: '1234' } })} />);
    expect(screen.getByDisplayValue('1234')).toBeInTheDocument();
  });

  it('uses English defaults for its chrome', () => {
    render(<ExternalIdsWidget {...props({ value: {} })} />);
    expect(screen.getByText('Add row')).toBeInTheDocument();
  });

  it('takes translated labels from ui:options', () => {
    // This widget ships on admin pages that must render in FR-CA.
    render(
      <ExternalIdsWidget
        {...props({ value: {}, options: { labels: { addRow: 'Ajouter une ligne' } } })}
      />,
    );
    expect(screen.getByText('Ajouter une ligne')).toBeInTheDocument();
    expect(screen.queryByText('Add row')).not.toBeInTheDocument();
  });

  it('names a stored system the way the tenant does, not by its code', () => {
    /**
     * The sources come from the tenant's own `ExternalIdSource` rows now. They used to be
     * a hardcoded list of four names offered as chips above the list, which was wrong in
     * both directions: it offered systems a tenant does not use, and it could not offer
     * one they had added.
     */
    render(
      <ExternalIdsWidget
        {...props({
          value: { netsuite: '1234' },
          options: { sources: [{ code: 'netsuite', label: 'NetSuite' }] },
        })}
      />,
    );
    expect(screen.getByRole('option', { name: 'NetSuite' })).toBeInTheDocument();
  });

  it('reports a map, not a row list, when a row changes', () => {
    // The schema layer only knows the final map; row ids are a UI concern.
    const onChange = vi.fn();
    render(<ExternalIdsWidget {...props({ value: { netsuite: '1234' }, onChange })} />);
    fireEvent.change(screen.getByDisplayValue('1234'), { target: { value: '5678' } });
    expect(onChange).toHaveBeenCalledWith({ netsuite: '5678' });
  });
});
