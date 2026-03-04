/**
 * BottomSheet — slide-up drawer replacing modals on mobile
 * Responds to touch-based mental model, not desktop hover
 */
import { useEffect, useRef, type ReactNode } from 'react';
import './BottomSheet.css';

interface BottomSheetProps {
    open: boolean;
    onClose: () => void;
    title?: string;
    children: ReactNode;
    maxHeight?: string;
}

export function BottomSheet({ open, onClose, title, children, maxHeight = '80dvh' }: BottomSheetProps) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [open, onClose]);

    // Prevent body scroll when sheet is open
    useEffect(() => {
        document.body.style.overflow = open ? 'hidden' : '';
        return () => { document.body.style.overflow = ''; };
    }, [open]);

    return (
        <>
            {/* Backdrop */}
            <div
                className={`sheet-backdrop ${open ? 'open' : ''}`}
                onClick={onClose}
                aria-hidden="true"
            />
            {/* Sheet */}
            <div
                ref={ref}
                className={`bottom-sheet ${open ? 'open' : ''}`}
                style={{ maxHeight }}
                role="dialog"
                aria-modal="true"
                aria-label={title}
            >
                <div className="bottom-sheet__handle" />
                {title && (
                    <div className="bottom-sheet__header">
                        <h3 className="bottom-sheet__title">{title}</h3>
                        <button
                            className="bottom-sheet__close btn btn-ghost"
                            onClick={onClose}
                            aria-label="Close"
                        >
                            ✕
                        </button>
                    </div>
                )}
                <div className="bottom-sheet__body">
                    {children}
                </div>
            </div>
        </>
    );
}
