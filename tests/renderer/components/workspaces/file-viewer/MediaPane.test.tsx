/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MediaPane } from '../../../../../src/renderer/components/workspaces/file-viewer/MediaPane';

describe('MediaPane', () => {
  it('plays a video from where it streams', () => {
    render(<MediaPane url="komla-preview://t/clip.mp4" kind="video" fileName="clip.mp4" />);

    expect(screen.getByTitle('clip.mp4')).toHaveAttribute('src', 'komla-preview://t/clip.mp4');
  });

  it('says a stream that failed while playing could not play', () => {
    const { rerender } = render(
      <MediaPane url="komla-preview://t/clip.mp4" kind="video" fileName="clip.mp4" />
    );

    fireEvent.error(screen.getByTitle('clip.mp4'));
    expect(screen.getByText("Couldn't play this video")).toBeInTheDocument();
    expect(screen.queryByTitle('clip.mp4')).not.toBeInTheDocument();

    // A new stream of the file plays again.
    rerender(<MediaPane url="komla-preview://u/clip.mp4" kind="video" fileName="clip.mp4" />);
    expect(screen.getByTitle('clip.mp4')).toHaveAttribute('src', 'komla-preview://u/clip.mp4');
  });

  it('says why a stream could not start', () => {
    render(<MediaPane url={null} kind="audio" fileName="song.mp3" error="host unreachable" />);

    expect(screen.getByText('host unreachable')).toBeInTheDocument();
  });
});
