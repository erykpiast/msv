import { Button, Drawer, Group, ScrollArea, Stack } from '@mantine/core';
import { useEffect, useMemo } from 'react';
import { useViewContext } from '../ViewContext';
import { renderLeaf } from './leafRenderers';
import { useCanvasRoute, type LeafRef } from '../hooks/useHashRoute';
import { tokens } from '../theme/tokens';

export function DetailDrawer({
  leaf,
  onClose,
}: {
  leaf?: LeafRef;
  onClose: () => void;
}) {
  const view = useViewContext();
  const { route } = useCanvasRoute();
  const territoryId = route.canvas === 'wg' ? route.territoryId : undefined;

  useEffect(() => {
    if (!leaf) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [leaf, onClose]);

  const rendered = useMemo(
    () => (leaf ? renderLeaf(leaf, view, { territoryId }) : null),
    [leaf, view, territoryId]
  );

  if (!leaf || !rendered) return null;

  const onCopy = () => { void navigator.clipboard.writeText(rendered.raw ?? ''); };

  return (
    <Drawer
      opened
      onClose={onClose}
      position="right"
      size={tokens.drawerWidth}
      overlayProps={{ backgroundOpacity: 0 }}
      title={rendered.title}
      withCloseButton
      keepMounted={false}
    >
      <Stack gap="sm" h="100%">
        <ScrollArea h="calc(100vh - 160px)">{rendered.body}</ScrollArea>
        <Group justify="flex-end">
          <Button size="xs" variant="default" onClick={onCopy}>Copy raw</Button>
        </Group>
      </Stack>
    </Drawer>
  );
}
