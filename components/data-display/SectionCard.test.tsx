// VeloExpense: ExpenseOS lints with Biome, which has no Next.js page-link rule; these plain
// anchors are the rows a card is handed in the test, as in ExpenseOS, not app navigation.
/* eslint-disable @next/next/no-html-link-for-pages */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SectionCard, SectionEmpty } from './SectionCard'; // VeloExpense: vendored from the kit as `data-display/SectionCard` (ExpenseOS: `ui/section-card`).

/**
 * The card shell extracted from `/my-info`'s activity sections for the dashboard's preview
 * cards.
 *
 * Three of the four things asserted here are the reasons the shell exists at all rather
 * than each page drawing its own chrome: the footer must be absent when the caller says
 * so, the pending face must be a skeleton and not a number, and the failure face must say
 * it failed rather than say the section is empty.
 *
 * `/my-info` has since been deleted and `/dashboard` is the shell's only consumer, which
 * makes these four cases the whole of its contract rather than a cross-caller agreement —
 * and makes them worth MORE, not less: with no second caller to notice a regression on its
 * own page, this file is the only thing between the shell and a silent behaviour change.
 * See the component's docstring and `ADR-0002` § Consequences on why it stays here.
 */
describe('<SectionCard>', () => {
  it('draws the header, the body and the footer', () => {
    render(
      <SectionCard
        title="My expense reports"
        headerRight={<span>2 approved</span>}
        footer={<a href="/expenses">View all</a>}
      >
        <div>rows</div>
      </SectionCard>,
    );
    expect(screen.getByRole('heading', { name: 'My expense reports' })).toBeInTheDocument();
    expect(screen.getByText('2 approved')).toBeInTheDocument();
    expect(screen.getByText('rows')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View all' })).toBeInTheDocument();
  });

  /**
   * THE TRAP THIS SHELL WAS BUILT AROUND.
   *
   * On `/my-info` the "view all" link lived inside the row list, so it rendered only when
   * there are rows. Hoisting such a link into the shell's footer and passing it
   * unconditionally would put "View all" directly underneath "You have no reports" — a
   * link into a listing the reader has just been told is empty.
   *
   * The prop is optional, the caller passes it from the non-empty branch only, and this is
   * the assertion that keeps it that way: an omitted footer renders NOTHING, so a caller
   * that forgets the branch has a visible bug rather than an inherited one.
   */
  it('renders no footer at all when the caller omits it', () => {
    render(
      <SectionCard title="My expense reports">
        <SectionEmpty message="No reports yet" hint="They will show up here." />
      </SectionCard>,
    );
    expect(screen.getByText('No reports yet')).toBeInTheDocument();
    expect(screen.getByText('They will show up here.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('draws a skeleton instead of the body while loading, and announces it', () => {
    /** Never a zero: a panel that states a number is making a claim, and a claim of zero
     *  while the data is still in flight is a wrong claim stated confidently. */
    render(
      <SectionCard title="My expense reports" loading loadingLabel="Loading your reports">
        <div>rows</div>
      </SectionCard>,
    );
    expect(screen.queryByText('rows')).not.toBeInTheDocument();
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Loading your reports');
  });

  it('hides the footer while loading', () => {
    /** A "view all" under a skeleton claims the section has contents nobody has counted
     *  yet. */
    render(
      <SectionCard title="Reports" loading footer={<a href="/expenses">View all</a>}>
        <div>rows</div>
      </SectionCard>,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('replaces the body with the error face, and never with an empty state', () => {
    /**
     * The list renderer these cards wrap has no error prop, and faking one through its
     * empty template would tell the reader "you have nothing" when the truth is "we could
     * not find out". The two sentences are not interchangeable.
     */
    render(
      <SectionCard
        title="Reports"
        error={{
          message: 'We could not load this section.',
          action: <button type="button">Try again</button>,
        }}
        footer={<a href="/expenses">View all</a>}
      >
        <div>rows</div>
      </SectionCard>,
    );
    expect(screen.queryByText('rows')).not.toBeInTheDocument();
    expect(screen.getByText('We could not load this section.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    // …and no link into a listing whose contents we just failed to read.
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('takes the error face over the loading face', () => {
    render(
      <SectionCard title="Reports" loading loadingLabel="Loading" error={{ message: 'Failed.' }}>
        <div>rows</div>
      </SectionCard>,
    );
    expect(screen.getByText('Failed.')).toBeInTheDocument();
    expect(screen.queryByText('Loading')).not.toBeInTheDocument();
  });

  it('titles at h3 by default and at h2 when the page asks for it', () => {
    /** `/my-info`'s sections were h3; a dashboard card is a top-level section of its page and
     *  sits under the greeting's h1 as an h2. The shell must not force one outline on both. */
    const { rerender } = render(<SectionCard title="Reports" />);
    expect(screen.getByRole('heading', { level: 3, name: 'Reports' })).toBeInTheDocument();
    rerender(<SectionCard title="Reports" headingLevel={2} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Reports' })).toBeInTheDocument();
  });
});
