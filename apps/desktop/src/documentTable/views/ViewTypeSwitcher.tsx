import type { ComponentType, SVGProps } from "react";
import MingcuteCalendarLine from "~icons/mingcute/calendar-line";
import MingcuteLayoutGridLine from "~icons/mingcute/layout-grid-line";
import MingcuteTable2Line from "~icons/mingcute/table-2-line";
import { cn } from "../../lib/utils";
import { setDocumentViewType } from "../documentTableStore";
import type { DocumentViewType } from "../properties/documentViews";

const VIEW_TYPE_OPTIONS: {
	type: DocumentViewType;
	label: string;
	Icon: ComponentType<SVGProps<SVGSVGElement>>;
}[] = [
	{ type: "table", label: "Table", Icon: MingcuteTable2Line },
	{ type: "board", label: "Board", Icon: MingcuteLayoutGridLine },
	{ type: "calendar", label: "Calendar", Icon: MingcuteCalendarLine },
];

/** Table / Board / Calendar. Saved into the active saved view, like its sort. */
export function ViewTypeSwitcher({ value }: { value: DocumentViewType }) {
	return (
		<div
			role="radiogroup"
			aria-label="Layout"
			className="flex shrink-0 items-center gap-0.5 rounded-mdly-control bg-mdly-control p-0.5"
		>
			{VIEW_TYPE_OPTIONS.map(({ type, label, Icon }) => (
				<button
					key={type}
					type="button"
					role="radio"
					aria-checked={value === type}
					title={label}
					onClick={() => setDocumentViewType(type)}
					className={cn(
						"flex h-6 items-center gap-1 rounded-[11px] px-2.5 text-xs text-muted-foreground outline-hidden transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-mdly-ink",
						value === type &&
							"mdly-ink-button text-mdly-ink-foreground hover:text-mdly-ink-foreground",
					)}
				>
					<Icon aria-hidden="true" className="size-3.5" />
					{label}
				</button>
			))}
		</div>
	);
}
