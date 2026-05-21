import { type ReactNode, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Popover } from '@mantine/core';

/**
 * Shared card chrome for WG visualization nodes used by both the WG Map
 * (`map/`) and Evidence (`evidence/`) panels. Encapsulates the React Flow
 * handles, the fixed-size bordered card target, and the Mantine popover.
 *
 * Each node component is a thin wrapper that supplies the `borderColor`,
 * the card body via `children`, and the popover body via `popover`.
 */
export function FlowCard({
  borderColor,
  width = 180,
  height = 60,
  popoverWidth = 320,
  children,
  popover,
}: {
  borderColor: string;
  width?: number;
  height?: number;
  popoverWidth?: number;
  children: ReactNode;
  popover: ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <Handle type="target" position={Position.Bottom} />
      <Popover
        opened={opened}
        onClose={() => setOpened(false)}
        position="top"
        withArrow
        shadow="md"
        width={popoverWidth}
      >
        <Popover.Target>
          <div
            onClick={() => setOpened((o) => !o)}
            style={{
              width,
              height,
              border: `2px solid ${borderColor}`,
              borderRadius: 6,
              background: '#fff',
              padding: '4px 8px',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              gap: 4,
              overflow: 'hidden',
            }}
          >
            {children}
          </div>
        </Popover.Target>
        <Popover.Dropdown>{popover}</Popover.Dropdown>
      </Popover>
      <Handle type="source" position={Position.Top} />
    </>
  );
}
