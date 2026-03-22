import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../hooks/use-session";
import { apiRequest } from "../services/api";
import { KnowledgeItem } from "../types/models";

type KnowledgeCardProps = {
  item: KnowledgeItem;
  isEditing: boolean;
  isDeleting: boolean;
  onEdit: (item: KnowledgeItem) => void;
  onDelete: (itemId: string) => void;
};

function KnowledgeCard({
  item,
  isEditing,
  isDeleting,
  onEdit,
  onDelete,
}: KnowledgeCardProps) {
  return (
    <article
      className={[
        "rounded-2xl border p-4 transition",
        isEditing
          ? "border-slate-900 bg-slate-50 shadow-sm"
          : "border-slate-200 bg-white",
      ].join(" ")}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-900">{item.title}</h3>
            {isEditing ? (
              <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 ring-1 ring-blue-200">
                Editing
              </span>
            ) : null}
          </div>

          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">
            {item.content}
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {item.tags.length ? (
              item.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200"
                >
                  {tag}
                </span>
              ))
            ) : (
              <span className="text-xs text-slate-400">No tags</span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => onEdit(item)}
            className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-300 px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Edit
          </button>

          <button
            type="button"
            onClick={() => onDelete(item._id)}
            disabled={isDeleting}
            className="inline-flex h-10 items-center justify-center rounded-xl border border-rose-200 px-4 text-sm font-medium text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isDeleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </article>
  );
}

export function KnowledgePage() {
  const { activeWorkspace } = useSession();
  const workspaceId = activeWorkspace?._id;

  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const [isBooting, setIsBooting] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    if (!workspaceId) return;

    const response = await apiRequest<{ items: KnowledgeItem[] }>(
      "/api/knowledge",
      {},
      { workspaceId }
    );

    setItems(response.items);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;

    let cancelled = false;

    async function boot() {
      try {
        setIsBooting(true);
        setError(null);

        const response = await apiRequest<{ items: KnowledgeItem[] }>(
          "/api/knowledge",
          {},
          { workspaceId }
        );

        if (!cancelled) {
          setItems(response.items);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load knowledge items."
          );
        }
      } finally {
        if (!cancelled) {
          setIsBooting(false);
        }
      }
    }

    void boot();

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const resetForm = () => {
    setEditingId(null);
    setTitle("");
    setContent("");
    setTags("");
  };

  const parsedTags = useMemo(
    () =>
      tags
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    [tags]
  );

  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    if (!query) return items;

    return items.filter((item) => {
      return (
        item.title.toLowerCase().includes(query) ||
        item.content.toLowerCase().includes(query) ||
        item.tags.some((tag) => tag.toLowerCase().includes(query))
      );
    });
  }, [items, searchQuery]);

  const totalTags = useMemo(() => {
    return new Set(items.flatMap((item) => item.tags)).size;
  }, [items]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspaceId) return;

    const trimmedTitle = title.trim();
    const trimmedContent = content.trim();

    if (!trimmedTitle || !trimmedContent) {
      setError("Title and content are required.");
      return;
    }

    try {
      setIsSaving(true);
      setError(null);

      const payload = {
        title: trimmedTitle,
        content: trimmedContent,
        tags: parsedTags,
      };

      if (editingId) {
        await apiRequest(`/api/knowledge/${editingId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } else {
        await apiRequest("/api/knowledge", {
          method: "POST",
          body: JSON.stringify({
            workspaceId,
            ...payload,
          }),
        });
      }

      resetForm();
      await loadItems();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save knowledge item."
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = (item: KnowledgeItem) => {
    setEditingId(item._id);
    setTitle(item.title);
    setContent(item.content);
    setTags(item.tags.join(", "));
    setError(null);
  };

  const handleDelete = async (itemId: string) => {
    try {
      setDeletingId(itemId);
      setError(null);

      await apiRequest(`/api/knowledge/${itemId}`, {
        method: "DELETE",
      });

      if (editingId === itemId) {
        resetForm();
      }

      await loadItems();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to delete knowledge item."
      );
    } finally {
      setDeletingId(null);
    }
  };

  if (!workspaceId) {
    return (
      <div className="p-6">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          No workspace session found.
        </div>
      </div>
    );
  }

  if (isBooting) {
    return (
      <div className="space-y-6 p-6">
        <div className="animate-pulse rounded-3xl border border-slate-200 bg-white p-6">
          <div className="h-4 w-32 rounded bg-slate-200" />
          <div className="mt-3 h-8 w-[28rem] rounded bg-slate-200" />
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(340px,0.9fr)_minmax(0,1.1fr)]">
          <div className="space-y-4 rounded-3xl border border-slate-200 bg-white p-6">
            <div className="h-12 rounded-2xl bg-slate-100" />
            <div className="h-40 rounded-2xl bg-slate-100" />
            <div className="h-12 rounded-2xl bg-slate-100" />
            <div className="h-24 rounded-2xl bg-slate-100" />
          </div>

          <div className="space-y-3 rounded-3xl border border-slate-200 bg-white p-6">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-36 rounded-2xl bg-slate-100" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6 p-6">
      <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Knowledge Base
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
              Structured answers for product and policy questions
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-slate-500">
              Store reusable policy guidance, product facts, and operational notes
              that help agents and automations answer consistently.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
              {items.length} items
            </span>
            <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
              {totalTags} tags
            </span>
          </div>
        </div>
      </header>

      {error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(340px,0.9fr)_minmax(0,1.1fr)]">
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Editor
              </p>
              <h3 className="mt-2 text-lg font-semibold text-slate-900">
                {editingId ? "Edit knowledge item" : "Create knowledge item"}
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Keep entries concise, searchable, and tagged by topic.
              </p>
            </div>

            {editingId ? (
              <span className="inline-flex rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 ring-1 ring-blue-200">
                Editing existing item
              </span>
            ) : null}
          </div>

          <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-900">
                Title
              </span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Return policy for opened items"
                className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-900">
                Content
              </span>
              <textarea
                rows={8}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder="Opened items can be returned within 7 days when the original packaging and accessories are included..."
                className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-900">
                Tags
              </span>
              <input
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="pricing, shipping, returns"
                className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Separate tags with commas.
              </p>
            </label>

            {parsedTags.length ? (
              <div className="flex flex-wrap gap-2">
                {parsedTags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
              <button
                className="inline-flex h-11 items-center justify-center rounded-xl bg-slate-900 px-5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                type="submit"
                disabled={isSaving}
              >
                {isSaving
                  ? editingId
                    ? "Saving..."
                    : "Creating..."
                  : editingId
                    ? "Save changes"
                    : "Add item"}
              </button>

              {editingId ? (
                <button
                  className="inline-flex h-11 items-center justify-center rounded-xl border border-slate-300 px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
                  onClick={resetForm}
                  type="button"
                >
                  Cancel edit
                </button>
              ) : null}
            </div>
          </form>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Library
              </p>
              <h3 className="mt-2 text-lg font-semibold text-slate-900">
                Knowledge items
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Search by title, content, or tag.
              </p>
            </div>

            <div className="w-full md:w-72">
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search knowledge..."
                className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
              />
            </div>
          </div>

          <div className="mt-6 space-y-3">
            {filteredItems.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-500">
                {items.length === 0
                  ? "No knowledge items yet."
                  : "No knowledge items match your search."}
              </div>
            ) : (
              filteredItems.map((item) => (
                <KnowledgeCard
                  key={item._id}
                  item={item}
                  isEditing={editingId === item._id}
                  isDeleting={deletingId === item._id}
                  onEdit={handleEdit}
                  onDelete={(itemId) => void handleDelete(itemId)}
                />
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}