import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar } from './Avatar';

/**
 * The avatar's image-or-initials fork.
 *
 * The rule worth pinning is that the background variant is applied ONLY on the
 * initials branch. A photo painted over `bg-primary` shows a coloured ring wherever
 * the image is not perfectly square, which is what most externally-sourced avatars
 * (Google) are not.
 */

describe('the image branch', () => {
  it('renders the photo when one is given', () => {
    render(<Avatar imageUrl="https://x/y.png" initials="AL" />);
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'https://x/y.png');
  });

  it('prefers an explicit alt', () => {
    render(<Avatar imageUrl="https://x/y.png" initials="AL" alt="Ada Lovelace" />);
    expect(screen.getByAltText('Ada Lovelace')).toBeInTheDocument();
  });

  it('falls back to the initials for alt text', () => {
    render(<Avatar imageUrl="https://x/y.png" initials="AL" />);
    expect(screen.getByAltText('AL')).toBeInTheDocument();
  });

  it('falls back to an empty alt when there is nothing to say', () => {
    // Empty alt is correct for a decorative image — better than the filename.
    render(<Avatar imageUrl="https://x/y.png" />);
    expect(screen.getByRole('presentation', { hidden: true })).toBeInTheDocument();
  });

  it('omits the fill colour so the photo is not ringed', () => {
    const { container } = render(<Avatar imageUrl="https://x/y.png" />);
    expect(container.firstElementChild?.className).not.toContain('bg-primary');
  });

  it('does not paint the initials underneath', () => {
    render(<Avatar imageUrl="https://x/y.png" initials="AL" />);
    expect(screen.queryByText('AL')).not.toBeInTheDocument();
  });
});

describe('the initials branch', () => {
  it('paints the initials', () => {
    render(<Avatar initials="AL" />);
    expect(screen.getByText('AL')).toBeInTheDocument();
  });

  it('is exposed as an image with its label', () => {
    render(<Avatar initials="AL" alt="Ada Lovelace" />);
    expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toBeInTheDocument();
  });

  it('renders an empty circle rather than "undefined" with no initials', () => {
    const { container } = render(<Avatar />);
    expect(container.textContent).toBe('');
  });

  it('applies the solid fill by default', () => {
    const { container } = render(<Avatar initials="AL" />);
    expect(container.firstElementChild?.className).toContain('bg-primary');
    expect(container.firstElementChild?.className).toContain('text-primary-foreground');
  });

  it('applies the soft fill on request', () => {
    // Reserved for dense contexts where many avatars compete for attention.
    const { container } = render(<Avatar initials="AL" variant="soft" />);
    expect(container.firstElementChild?.className).toContain('bg-primary/15');
  });
});

describe('sizing', () => {
  it('defaults to md', () => {
    const { container } = render(<Avatar initials="AL" />);
    expect(container.firstElementChild?.className).toContain('h-8 w-8');
  });

  it('maps every named size', () => {
    const sizes = [
      ['sm', 'h-6 w-6'],
      ['md', 'h-8 w-8'],
      ['lg', 'h-10 w-10'],
      ['xl', 'h-[72px] w-[72px]'],
    ] as const;
    for (const [size, cls] of sizes) {
      const { container, unmount } = render(<Avatar initials="AL" size={size} />);
      expect(container.firstElementChild?.className).toContain(cls);
      unmount();
    }
  });

  it('gives the hero size extra weight and a ring', () => {
    const { container } = render(<Avatar initials="AL" size="xl" />);
    const cls = container.firstElementChild?.className ?? '';
    expect(cls).toContain('font-extrabold');
    expect(cls).toContain('border-white/30');
  });
});

describe('overlay', () => {
  it('renders alongside the initials', () => {
    render(<Avatar initials="AL" overlay={<span>online</span>} />);
    expect(screen.getByText('online')).toBeInTheDocument();
  });

  it('renders alongside the photo', () => {
    render(<Avatar imageUrl="https://x/y.png" overlay={<span>online</span>} />);
    expect(screen.getByText('online')).toBeInTheDocument();
  });
});
