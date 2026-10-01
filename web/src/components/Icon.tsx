interface IconProps {
  name: IconName;
  size?: number;
}

export type IconName =
  | 'file-plus'
  | 'folder-plus'
  | 'upload-file'
  | 'upload-folder'
  | 'copy-code'
  | 'copy-text'
  | 'timer'
  | 'menu'
  | 'close'
  | 'link';

const PATHS: Record<IconName, string[]> = {
  'file-plus': [
    'M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-6-6z',
    'M13 3v6h6',
    'M12 12v6 M9 15h6',
  ],
  'folder-plus': [
    'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
    'M12 11v6 M9 14h6',
  ],
  'upload-file': [
    'M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-6-6z',
    'M13 3v6h6',
    'M12 17v-5 M9.5 14.5 12 12l2.5 2.5',
  ],
  'upload-folder': [
    'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
    'M12 16v-5 M9.5 13.5 12 11l2.5 2.5',
  ],
  'copy-code': ['M9 9h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V9z', 'M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1'],
  'copy-text': ['M8 8h12 M8 12h12 M8 16h8', 'M4 4h2v14H4z'],
  timer: ['M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M12 9v4l2.5 2.5', 'M9 2h6'],
  menu: ['M4 6h16 M4 12h16 M4 18h16'],
  close: ['M6 6l12 12 M18 6L6 18'],
  link: ['M10 14a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1', 'M14 10a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1'],
};

export default function Icon({ name, size = 18 }: IconProps) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {(PATHS[name] ?? []).map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
