import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ColorInput } from './ColorInput';

/**
 * The colour picker used by the category and class colour fields.
 *
 * Written because of the first test below: the text field could not be typed into. A colour
 * string is only forwardable once it is complete, so a partial one was dropped — and since
 * the field is controlled from that same rejected upstream value, React put the old text
 * back after every keystroke. Six valid hex characters produced nothing at all. Only the
 * native swatch worked, which is presumably why nobody hit it: you can still pick a colour,
 * just not say which one.
 *
 * The rest covers what a picker has to get right once you can use it: alpha surviving a
 * swatch change, the format toggle not silently rewriting the value, and a partial value
 * never reaching the caller.
 */

/** The picker plus a readout of whatever the caller last received. */
function Host({
  initial = '#000000',
  ...props
}: { initial?: string } & Partial<Parameters<typeof ColorInput>[0]>) {
  const [v, setV] = useState<string>(initial);
  const spy = (props.onValueChange as ((s: string) => void) | undefined) ?? (() => {});
  return (
    <>
      <ColorInput
        {...props}
        value={v}
        onValueChange={(next) => {
          setV(next);
          spy(next);
        }}
      />
      <output data-testid="value">{v}</output>
    </>
  );
}

const textField = () => screen.getByRole('textbox', { name: 'Color value' });
const emitted = () => screen.getByTestId('value').textContent;

/**
 * Pick a format from the HEX / RGB / HSL toggle.
 *
 * `findByRole` rather than `getByRole`: the listbox is portaled and mounts a tick after
 * the trigger is clicked, so a synchronous query misses it on reopen.
 */
async function switchFormat(label: 'HEX' | 'RGB' | 'HSL') {
  await userEvent.click(screen.getByLabelText('Color format'));
  await userEvent.click(await screen.findByRole('option', { name: label }));
}

describe('ColorInput — typing a colour by hand (regression)', () => {
  it('accepts a hex code typed one character at a time', async () => {
    /**
     * The bug, exactly as a user hits it: clear the field, type `ff0000`. Before the fix
     * the field ended EMPTY and the caller received nothing — every keystroke was
     * validated, rejected, and overwritten by a re-render from the unchanged parent value.
     */
    render(<Host initial="#000000" showFormatToggle={false} />);
    const field = textField();
    await userEvent.clear(field);
    await userEvent.type(field, 'ff0000');

    expect(field).toHaveValue('#ff0000');
    expect(emitted()).toBe('#ff0000');
  });

  it('keeps a half-typed value on screen without sending it upstream', async () => {
    // Both halves matter. The text has to stay visible or the field is unusable; the
    // caller must NOT see `#ff` or it would render a colour the user never chose.
    const onValueChange = vi.fn();
    render(<Host initial="#123456" showFormatToggle={false} onValueChange={onValueChange} />);
    const field = textField();
    await userEvent.clear(field);
    await userEvent.type(field, 'ff');

    expect(field, 'the partial value vanished from the field').toHaveValue('#ff');
    // '' from the clear is allowed through; '#ff' is not.
    expect(onValueChange.mock.calls.map((c) => c[0])).not.toContain('#ff');
  });

  it('accepts a typed rgb() string, which is equally partial while being typed', async () => {
    // Same defect, other format: `rgb(255, 0,` does not parse, so the whole string used to
    // be unreachable by typing.
    render(<Host initial="rgb(1, 2, 3)" showFormatToggle={false} />);
    const field = textField();
    await userEvent.clear(field);
    await userEvent.type(field, 'rgb(255, 0, 0)');

    expect(field).toHaveValue('rgb(255, 0, 0)');
    expect(emitted()).toBe('rgb(255, 0, 0)');
  });

  it('canonicalises on blur, so the stored form is predictable', async () => {
    // While editing, what the user typed stays put. Once they leave, the field shows the
    // canonical rendering — otherwise `#ABC` and `#aabbcc` would both linger as "the
    // value" depending on how it was entered.
    render(<Host initial="#000000" showFormatToggle={false} />);
    const field = textField();
    await userEvent.clear(field);
    await userEvent.type(field, 'abc');
    expect(field).toHaveValue('#abc');

    await userEvent.tab();
    expect(field).toHaveValue('#aabbcc');
  });
});

describe('ColorInput — the swatch', () => {
  it('applies the picked colour', () => {
    // jsdom cannot open a native picker, so the change event is dispatched directly. The
    // component's handler is what is under test, not the browser widget.
    render(<Host initial="#000000" showFormatToggle={false} />);
    fireEvent.change(screen.getByLabelText('Color swatch'), { target: { value: '#ff0000' } });
    expect(emitted()).toBe('#ff0000');
  });

  it('PRESERVES the existing alpha, which the native picker cannot carry', () => {
    /**
     * `<input type="color">` is 6-digit hex only — it has no concept of alpha. So the
     * component has to merge the picked rgb over the alpha it already had. Without that,
     * touching the swatch on a 50%-opaque colour silently makes it fully opaque, and the
     * only visible symptom is a category swatch that got bolder.
     */
    render(<Host initial="#00ff0080" showAlpha showFormatToggle={false} />);
    fireEvent.change(screen.getByLabelText('Color swatch'), { target: { value: '#ff0000' } });
    expect(emitted()).toBe('#ff000080');
    expect(screen.getByLabelText('Opacity')).toHaveValue(50);
  });

  it('emits in the format currently selected, not always hex', () => {
    // The swatch is hex-only, but the field the user is editing may not be. Emitting hex
    // regardless would flip the value's syntax out from under them.
    render(<Host initial="rgb(1, 2, 3)" />);
    fireEvent.change(screen.getByLabelText('Color swatch'), { target: { value: '#ff0000' } });
    expect(emitted()).toBe('rgb(255, 0, 0)');
  });

  it('shows black for an unparseable value rather than the browser default', () => {
    // `<input type="color">` with an invalid value renders whatever the browser feels
    // like, which would misrepresent the stored colour.
    render(<Host initial="not-a-colour" showFormatToggle={false} />);
    expect(screen.getByLabelText('Color swatch')).toHaveValue('#000000');
  });
});

describe('ColorInput — alpha', () => {
  it('is hidden unless asked for', () => {
    render(<Host initial="#000000" />);
    expect(screen.queryByLabelText('Opacity')).not.toBeInTheDocument();
  });

  it('encodes into the emitted value', async () => {
    render(<Host initial="#ff0000" showAlpha showFormatToggle={false} />);
    const alpha = screen.getByLabelText('Opacity');
    await userEvent.clear(alpha);
    await userEvent.type(alpha, '50');
    // 50% of 255 is 127.5 → 128 → `80`.
    expect(emitted()).toBe('#ff000080');
  });

  it('still produces a VALID colour from out-of-range input', async () => {
    /**
     * Named for what this actually verifies. `handleAlphaChange` clamps to 0..100, but that
     * clamp is not observable from here — `formatColor`/`toHex` clamp again downstream, so
     * `150` and `100` emit the same string either way (mutation-checked). What IS worth
     * pinning is the outcome: whatever a user types, the emitted value parses.
     */
    render(<Host initial="#ff0000" showAlpha showFormatToggle={false} />);
    const alpha = screen.getByLabelText('Opacity');
    await userEvent.clear(alpha);
    await userEvent.type(alpha, '150');
    // Fully opaque hex drops the alpha component entirely.
    expect(emitted()).toBe('#ff0000');
  });

  it('reads back the alpha already on the value', () => {
    render(<Host initial="#ff000080" showAlpha showFormatToggle={false} />);
    expect(screen.getByLabelText('Opacity')).toHaveValue(50);
  });

  it('shows 100 for a value with no alpha', () => {
    render(<Host initial="#ff0000" showAlpha showFormatToggle={false} />);
    expect(screen.getByLabelText('Opacity')).toHaveValue(100);
  });
});

describe('ColorInput — format', () => {
  it('opens in the format the incoming value is written in', () => {
    // Otherwise the field reformats a stored value the moment it is displayed, and merely
    // opening a form rewrites data.
    const { unmount } = render(<Host initial="rgb(1, 2, 3)" />);
    expect(textField()).toHaveValue('rgb(1, 2, 3)');
    unmount();

    render(<Host initial="hsl(0, 100%, 50%)" />);
    expect(textField()).toHaveValue('hsl(0, 100%, 50%)');
  });

  it('hides the toggle when asked, locking the field to one syntax', () => {
    render(<Host initial="#ff0000" showFormatToggle={false} />);
    expect(screen.queryByLabelText('Color format')).not.toBeInTheDocument();
  });

  it('converts the value in place when switched', async () => {
    // The whole point of the toggle: the same colour, re-expressed. A toggle that changed
    // the colour rather than its notation would be worse than no toggle.
    render(<Host initial="#ff0000" />);
    await switchFormat('RGB');
    expect(emitted()).toBe('rgb(255, 0, 0)');
    expect(textField()).toHaveValue('rgb(255, 0, 0)');

    await switchFormat('HSL');
    expect(emitted()).toBe('hsl(0, 100%, 50%)');
  });

  it('carries alpha across a format switch', async () => {
    // Switching notation must not quietly discard opacity.
    render(<Host initial="#ff000080" showAlpha />);
    await switchFormat('RGB');
    expect(emitted()).toMatch(/^rgba\(255, 0, 0, 0\.5/);
  });

  it('DISCARDS a half-typed value when the format changes', async () => {
    /**
     * A draft is written in one syntax. Carried into another it would sit there as
     * `rgb(25` under an HSL label — text that cannot become valid in the format it is now
     * being validated against, so the field would be stuck until cleared by hand.
     *
     * Asserted as a behaviour rather than against a specific mechanism, because the
     * mechanism is not the obvious one: reaching the toggle requires clicking it, which
     * blurs the text field and clears the draft before `changeFormat` even runs. An
     * explicit reset inside `changeFormat` is therefore unreachable, and was removed.
     */
    render(<Host initial="rgb(1, 2, 3)" />);
    const field = textField();
    await userEvent.clear(field);
    await userEvent.type(field, 'rgb(25');
    expect(field).toHaveValue('rgb(25');

    await switchFormat('HSL');
    expect(textField()).not.toHaveValue('rgb(25');
  });

  it('does not emit anything for an unparseable value when the format changes', async () => {
    // Nothing to convert, so nothing should be written — a format toggle must not turn a
    // typo into a saved black.
    const onValueChange = vi.fn();
    render(<Host initial="nonsense" onValueChange={onValueChange} />);
    await switchFormat('RGB');
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

describe('ColorInput — disabled', () => {
  it('disables every control', () => {
    render(<Host initial="#ff0000" showAlpha disabled />);
    expect(screen.getByLabelText('Color swatch')).toBeDisabled();
    expect(textField()).toBeDisabled();
    expect(screen.getByLabelText('Opacity')).toBeDisabled();
  });
});
