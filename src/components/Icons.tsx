// Monochrome line icons - inherit currentColor, no emoji
interface IconProps {
  size?: number
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
})

export function CarIcon({ size = 15 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M2 11.5V13h2v-1.5M12 11.5V13h2v-1.5" />
      <path d="M1.6 8.2 3 4.6a1.4 1.4 0 0 1 1.3-.9h7.4a1.4 1.4 0 0 1 1.3.9l1.4 3.6v3.3H1.6z" />
      <path d="M4.2 10h.01M11.8 10h.01" />
    </svg>
  )
}

export function FerryIcon({ size = 15 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M1.7 10.6c.9 0 .9.9 1.9.9s1-.9 1.9-.9 1 .9 1.9.9 1-.9 1.9-.9 1 .9 1.9.9 1-.9 1.9-.9" />
      <path d="M3 9.6 3.9 6h8.2l.9 3.6M6 6V3.6h4V6M8 3.6V2" />
    </svg>
  )
}

export function GearIcon({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 1.4v1.8M8 12.8v1.8M14.6 8h-1.8M3.2 8H1.4M12.7 3.3l-1.3 1.3M4.6 11.4l-1.3 1.3M12.7 12.7l-1.3-1.3M4.6 4.6 3.3 3.3" />
    </svg>
  )
}

export function CloseIcon({ size = 15 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}
