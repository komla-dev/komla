import { forwardRef, type ComponentPropsWithoutRef, type MouseEvent, type Ref } from 'react';

import { Badge, badgeVariants } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { shownWorkspaceMarkers, type WorkspaceMarker } from '../../../shared/lib/workspace-markers';

import { ActivitySpinner } from './activity-spinners';

// No store here: the workspaces store imports the hover card that lists these.

/**
 * Opens a marker's link in the default browser, through the SSH host's tunnel for a localhost one
 * there. Loaded on the click, as the opener imports the workspaces store.
 */
function openMarkerLink(link: string, workspaceId: string): void {
  import('@/lib/open-terminal-url')
    .then(({ openLinkExternally }) => openLinkExternally(link, { workspaceId }))
    .catch((error: unknown) => console.error('Could not open the marker link', error));
}

function linkHost(link: string): string {
  try {
    return new URL(link).host;
  } catch {
    return link;
  }
}

type MarkerBadgeProps = { marker: WorkspaceMarker; workspaceId: string } & Omit<
  ComponentPropsWithoutRef<typeof Badge>,
  'tone' | 'variant'
> & {
    /**
     * Its own button for the keyboard. On the card it isn't one, as the card's details button
     * holds it: a click opens the link, and the keyboard opens the details, which list it as one.
     */
    asButton?: boolean;
    /** False while a click on the card picks it or restores it, which a click here then does too. */
    opensLink?: boolean;
  };

/**
 * A marker in its color, led by a spinner while it shows work under way. A click on one with a
 * link opens it and leaves the card it sits on alone, but a modifier click picks the card.
 */
export const WorkspaceMarkerBadge = forwardRef<HTMLElement, MarkerBadgeProps>(
  function WorkspaceMarkerBadge(
    { marker, workspaceId, asButton, opensLink = true, className, onClick, ...props },
    ref
  ) {
    const content = (
      <>
        {marker.spinner && <ActivitySpinner className="size-2.5 shrink-0" />}
        <span className="truncate">{marker.label}</span>
      </>
    );
    const link = opensLink ? marker.link : undefined;
    if (!link) {
      return (
        <Badge
          ref={ref as Ref<HTMLSpanElement>}
          tone={marker.tone}
          variant="outline"
          className={className}
          onClick={onClick}
          {...props}
        >
          {content}
        </Badge>
      );
    }
    // Only the click is the link's: a press still reaches the card, which drags it and tells the
    // details button it holds that a pointer, not the keyboard, focused it.
    const handlers = {
      onClick: (event: MouseEvent<HTMLElement>) => {
        // As the tooltip closes on a click.
        onClick?.(event as MouseEvent<HTMLSpanElement>);
        // On the card, Cmd, Ctrl and Shift pick it for a bulk action, as anywhere else on it.
        if (!asButton && (event.metaKey || event.ctrlKey || event.shiftKey)) return;
        event.stopPropagation();
        openMarkerLink(link, workspaceId);
      },
    };
    const linkClassName = cn(
      badgeVariants({ tone: marker.tone, variant: 'outline' }),
      'cursor-pointer hover:underline',
      className
    );
    if (asButton) {
      return (
        <button
          ref={ref as Ref<HTMLButtonElement>}
          type="button"
          className={cn(
            linkClassName,
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
          )}
          {...(props as ComponentPropsWithoutRef<'button'>)}
          {...handlers}
        >
          {content}
        </button>
      );
    }
    return (
      <span ref={ref as Ref<HTMLSpanElement>} className={linkClassName} {...props} {...handlers}>
        {content}
      </span>
    );
  }
);

/**
 * What a marker's tooltip says: its label, that it's under way if it is, its script's note, and
 * where its link goes.
 */
function MarkerTooltipText({
  marker,
  opensLink = true,
}: {
  marker: WorkspaceMarker;
  opensLink?: boolean;
}) {
  return (
    <>
      {marker.spinner ? `${marker.label}, under way` : marker.label}
      {marker.tooltip && <span className="text-muted-foreground"> · {marker.tooltip}</span>}
      {marker.link && opensLink && (
        <span className="text-muted-foreground"> · opens {linkHost(marker.link)}</span>
      )}
    </>
  );
}

/** One of a workspace's markers, as the card and the dashboard's row show it. */
export function WorkspaceMarkerPill({
  marker,
  workspaceId,
  opensLink,
  className,
}: {
  marker: WorkspaceMarker;
  workspaceId: string;
  opensLink?: boolean;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <WorkspaceMarkerBadge
          data-workspace-marker={marker.key}
          {...(marker.spinner && { 'data-workspace-progress': '' })}
          marker={marker}
          workspaceId={workspaceId}
          opensLink={opensLink}
          className={cn('max-w-32', className)}
        />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm">
        <MarkerTooltipText marker={marker} opensLink={opensLink} />
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Just the spinner of work under way, in its marker's color, for a card whose title row a
 * notification or a busy agent has taken: the pill waits behind them, and this says it's still on.
 */
export function WorkspaceProgressGlyph({ marker }: { marker: WorkspaceMarker }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          data-workspace-progress-glyph
          tone={marker.tone}
          variant="outline"
          className="shrink-0 px-1"
        >
          <ActivitySpinner className="size-2.5 shrink-0" />
          <span className="sr-only">{`${marker.label}, under way`}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm">
        <MarkerTooltipText marker={marker} />
      </TooltipContent>
    </Tooltip>
  );
}

/** A count of what the pill in the tag's place hides, naming each on hover. */
export function HiddenMarks({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-workspace-more-markers
          className="shrink-0 text-[10px] text-muted-foreground tabular-nums"
        >
          +{labels.length}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm">
        {labels.join(' · ')}
      </TooltipContent>
    </Tooltip>
  );
}

/** Every marker, with what its script says, as the hover card lists them. */
export function WorkspaceMarkerList({
  markers,
  workspaceId,
}: {
  markers: WorkspaceMarker[] | undefined;
  workspaceId: string;
}) {
  return shownWorkspaceMarkers(markers).map((marker) => (
    <div key={marker.key} className="mt-2 flex min-w-0 items-baseline gap-1.5 text-xs">
      <WorkspaceMarkerBadge
        data-workspace-info-marker={marker.key}
        {...(marker.spinner && { 'data-workspace-info-progress': '' })}
        marker={marker}
        workspaceId={workspaceId}
        asButton
        className="max-w-full shrink-0"
      />
      {marker.tooltip && (
        <span className="min-w-0 break-words text-muted-foreground">{marker.tooltip}</span>
      )}
    </div>
  ));
}
