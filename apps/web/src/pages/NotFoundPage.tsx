import { Link } from "react-router-dom";
import { Compass } from "lucide-react";
import { EmptyState } from "../components/ui/StateViews";

export default function NotFoundPage() {
  return (
    <div className="py-16">
      <EmptyState
        icon={Compass}
        title="页面不存在"
        description="这个地址没有对应的本地视图。可以返回相册库继续浏览。"
        action={
          <Link
            to="/"
            className="inline-flex h-9 items-center rounded-lg border border-white/10 bg-ink-800 px-3.5 text-sm font-medium text-ink-100 hover:bg-ink-700"
          >
            返回相册库
          </Link>
        }
        className="mx-auto max-w-lg"
      />
    </div>
  );
}
