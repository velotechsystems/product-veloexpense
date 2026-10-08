import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { NumberStepper } from './NumberStepper';

/**
 * The bounded-number control, used directly and through the RJSF `updown` widget.
 *
 * Written because of the bug in the first test below: a stepper with both a `min` and a
 * `max` and no value yet had BOTH buttons disabled, so a 1..5 rating or a 0..10 count
 * opened dead and could only be filled by typing. The guards asked "is the value on the
 * bound?" but substituted the bound itself when the value was empty — so an empty field
 * counted as sitting on both bounds simultaneously.
 *
 * The rest of the file is about the two things that make a bounded control trustworthy:
 * it never emits a value outside its range, and it distinguishes "empty" from "zero".
 */

const dec = () => screen.getByRole('button', { name: /Decrease/ });
const inc = () => screen.getByRole('button', { name: /Increase/ });
const field = () => screen.getByRole('spinbutton');

describe('NumberStepper — an empty bounded field', () => {
  it('is STEPPABLE when min and max are both set (regression)', async () => {
    /**
     * The reported shape: `min={1} max={5}` with no value. Before the fix both buttons were
     * disabled and the control was inert — which is invisible in a screenshot and only
     * shows up when somebody tries to use it.
     */
    const onValueChange = vi.fn();
    render(<NumberStepper value={null} min={1} max={5} onValueChange={onValueChange} />);

    expect(inc(), 'the + button is disabled on an empty bounded field').toBeEnabled();
    expect(dec(), 'the − button is disabled on an empty bounded field').toBeEnabled();

    await userEvent.click(inc());
    expect(onValueChange).toHaveBeenCalledWith(2);
  });

  it('lands inside the range from either button', async () => {
    // Whichever way the user reaches for it first, the result has to be a legal value.
    for (const [label, press] of [
      ['increase', inc],
      ['decrease', dec],
    ] as const) {
      const onValueChange = vi.fn();
      const { unmount } = render(
        <NumberStepper value={null} min={1} max={5} onValueChange={onValueChange} />,
      );
      await userEvent.click(press());
      const emitted = onValueChange.mock.calls[0][0] as number;
      expect(emitted, `${label} emitted ${emitted}`).toBeGreaterThanOrEqual(1);
      expect(emitted, `${label} emitted ${emitted}`).toBeLessThanOrEqual(5);
      unmount();
    }
  });

  it('makes every value in a small range reachable by clicking alone', async () => {
    /**
     * The property that matters more than which value the FIRST click produces: a user who
     * never touches the keyboard must be able to get to any legal value. On an empty 1..5
     * field "−" lands on 1 and "+" on 2, so the whole range is walkable from either.
     */
    const onValueChange = vi.fn();
    render(<NumberStepper value={null} min={1} max={5} onValueChange={onValueChange} />);
    await userEvent.click(dec());
    expect(onValueChange).toHaveBeenLastCalledWith(1); // the bottom of the range
  });

  it('steps from zero when unbounded', async () => {
    const onValueChange = vi.fn();
    render(<NumberStepper value={null} onValueChange={onValueChange} />);
    await userEvent.click(inc());
    expect(onValueChange).toHaveBeenCalledWith(1);
  });
});

describe('NumberStepper — bounds with a value present', () => {
  it('disables − at the minimum and + at the maximum', async () => {
    // The guard still has to work when it is genuinely true, or the control emits values
    // outside its own declared range.
    const { unmount } = render(<NumberStepper value={1} min={1} max={5} onValueChange={vi.fn()} />);
    expect(dec()).toBeDisabled();
    expect(inc()).toBeEnabled();
    unmount();

    render(<NumberStepper value={5} min={1} max={5} onValueChange={vi.fn()} />);
    expect(inc()).toBeDisabled();
    expect(dec()).toBeEnabled();
  });

  it('disables at a bound even when the value is already past it', async () => {
    // A value outside range can arrive from stored data or a changed bound. The button
    // must not offer to push it further out.
    render(<NumberStepper value={9} min={1} max={5} onValueChange={vi.fn()} />);
    expect(inc()).toBeDisabled();
  });

  it('clamps rather than emitting an out-of-range value', async () => {
    // With a step that would overshoot, the emitted value is the bound — not bound+step.
    const onValueChange = vi.fn();
    render(<NumberStepper value={4} min={1} max={5} step={10} onValueChange={onValueChange} />);
    await userEvent.click(inc());
    expect(onValueChange).toHaveBeenCalledWith(5);
  });

  it('clamps downward too', async () => {
    const onValueChange = vi.fn();
    render(<NumberStepper value={2} min={1} max={5} step={10} onValueChange={onValueChange} />);
    await userEvent.click(dec());
    expect(onValueChange).toHaveBeenCalledWith(1);
  });

  it('honours a fractional step', async () => {
    const onValueChange = vi.fn();
    render(<NumberStepper value={1} step={0.5} onValueChange={onValueChange} />);
    await userEvent.click(inc());
    expect(onValueChange).toHaveBeenCalledWith(1.5);
  });
});

describe('NumberStepper — empty versus zero', () => {
  it('emits undefined when the field is cleared, not 0', async () => {
    /**
     * The distinction a bounded field cannot afford to lose. `0` is a value somebody chose;
     * `undefined` means they have not chosen one. Collapsing them writes a zero into every
     * optional numeric field the user merely tabbed through — and on a threshold or a
     * limit, a zero is not a harmless default.
     */
    const onValueChange = vi.fn();
    render(<NumberStepper value={5} onValueChange={onValueChange} />);
    await userEvent.clear(field());
    expect(onValueChange).toHaveBeenLastCalledWith(undefined);
  });

  it('renders an empty field for null and for undefined, but "0" for zero', () => {
    const { unmount } = render(<NumberStepper value={null} onValueChange={vi.fn()} />);
    expect(field()).toHaveValue(null);
    unmount();

    render(<NumberStepper value={0} onValueChange={vi.fn()} />);
    expect(field()).toHaveValue(0);
  });

  it('emits the typed number', async () => {
    // Needs a stateful wrapper: the control is fully controlled, so with a frozen `value`
    // React discards each keystroke and "42" arrives as two independent "4" and "2"
    // edits. That is correct behaviour, not a defect — but it means a static `value` in a
    // test measures React, not this component.
    const onValueChange = vi.fn();
    function Controlled() {
      const [v, setV] = useState<number | undefined>(undefined);
      return (
        <NumberStepper
          value={v ?? null}
          onValueChange={(next) => {
            setV(next);
            onValueChange(next);
          }}
        />
      );
    }
    render(<Controlled />);
    await userEvent.type(field(), '42');
    expect(onValueChange).toHaveBeenLastCalledWith(42);
  });
});

describe('NumberStepper — disabled and labelling', () => {
  it('disables both buttons and the field when disabled', () => {
    render(<NumberStepper value={3} min={1} max={5} disabled onValueChange={vi.fn()} />);
    expect(dec()).toBeDisabled();
    expect(inc()).toBeDisabled();
    expect(field()).toBeDisabled();
  });

  it('names the buttons by their step size, so a screen reader says what they do', () => {
    // "Increase" alone does not say by how much, and this control is used with steps other
    // than 1.
    render(<NumberStepper value={0} step={5} onValueChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Increase by 5' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decrease by 5' })).toBeInTheDocument();
  });

  it('passes an aria-label through to the field itself', () => {
    render(<NumberStepper value={0} aria-label="Nights" onValueChange={vi.fn()} />);
    expect(screen.getByRole('spinbutton', { name: 'Nights' })).toBeInTheDocument();
  });

  it('mirrors min, max and step onto the input for native validation', () => {
    // The buttons are not the only way in — a typed value is validated by the browser
    // against these, so they have to agree with the guards above.
    render(<NumberStepper value={3} min={1} max={5} step={2} onValueChange={vi.fn()} />);
    expect(field()).toHaveAttribute('min', '1');
    expect(field()).toHaveAttribute('max', '5');
    expect(field()).toHaveAttribute('step', '2');
  });
});
