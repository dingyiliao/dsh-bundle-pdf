#include "public/dsh_outlines.h"

#include <algorithm>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "core/fpdfapi/parser/cpdf_array.h"
#include "core/fpdfapi/parser/cpdf_dictionary.h"
#include "core/fpdfapi/parser/cpdf_document.h"
#include "core/fpdfapi/parser/cpdf_name.h"
#include "core/fpdfapi/parser/cpdf_number.h"
#include "core/fpdfapi/parser/cpdf_reference.h"
#include "core/fpdfapi/parser/cpdf_string.h"
#include "core/fpdfdoc/cpdf_bookmark.h"
#include "core/fxcrt/fx_stream.h"
#include "fpdfsdk/cpdfsdk_helpers.h"

namespace {

constexpr size_t kMaxItems = 5000;
constexpr size_t kMaxDepth = 64;
constexpr size_t kMaxIdBytes = 2048;
constexpr size_t kMaxIdUtf16 = 512;
constexpr size_t kMaxTitleUtf16 = 1024;
constexpr char kStableIdKey[] = "DSHPDFOutlineId";

struct OutlineItem {
  RetainPtr<CPDF_Dictionary> dict;
  ByteString id;
  ByteString title;
  int parent;
  int page;
  bool open;
};

struct StaleLink {
  RetainPtr<const CPDF_Dictionary> actual;
  const CPDF_Dictionary* expected;
};

struct OutlineTree {
  RetainPtr<CPDF_Dictionary> root;
  std::vector<OutlineItem> items;
  std::set<const CPDF_Dictionary*> seen;
  std::set<ByteString> ids;
  std::vector<StaleLink> stale_links;
  bool needs_relink = false;
};

bool Absent(const CPDF_Object* object) {
  return !object || object->IsNull();
}

bool IsValidId(const ByteString& id) {
  if (id.IsEmpty() || id.GetLength() > kMaxIdBytes ||
      std::find(id.begin(), id.end(), '\0') != id.end()) {
    return false;
  }
  auto text = WideString::FromUTF8(id.AsStringView());
  if (text.ToUTF16LE().GetLength() > (kMaxIdUtf16 + 1) * 2) {
    return false;
  }
  text.Trim(L" \t\r\n\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005"
            L"\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff");
  return !text.IsEmpty();
}

int LocalPage(CPDF_Document* document,
              RetainPtr<const CPDF_Dictionary> dictionary) {
  auto destination = dictionary->GetDirectObjectFor("Dest");
  if (Absent(destination.Get())) {
    const auto action = CPDF_Bookmark(dictionary).GetAction();
    if (action.GetType() == CPDF_Action::Type::kGoTo) {
      destination = action.GetDict()->GetDirectObjectFor("D");
    }
  }
  for (size_t depth = 0; destination && destination->IsDictionary() &&
                         depth < kMaxDepth; ++depth) {
    destination = destination->AsDictionary()->GetDirectObjectFor("D");
  }
  const int page = CPDF_Dest::Create(document, destination).GetDestPageIndex(document);
  return page >= 0 && page < document->GetPageCount() ? page : -1;
}

void CheckBacklink(OutlineTree* tree,
                   const CPDF_Dictionary& owner,
                   ByteStringView key,
                   const CPDF_Dictionary* expected) {
  const auto raw = owner.GetObjectFor(key);
  const auto actual = owner.GetDictFor(key);
  if (actual.Get() == expected && (expected || Absent(raw.Get()))) {
    return;
  }
  tree->needs_relink = true;
  if (actual) {
    tree->stale_links.push_back({actual, expected});
  }
}

class BoundedArchive final : public IFX_ArchiveStream {
 public:
  bool WriteBlock(pdfium::span<const uint8_t> bytes) override {
    if (bytes.size() > 256 * 1024 - contents.size()) {
      return false;
    }
    contents.insert(contents.end(), bytes.begin(), bytes.end());
    return true;
  }

  FX_FILESIZE CurrentOffset() const override { return contents.size(); }

  std::vector<uint8_t> contents;
};

bool WriteOutlinePayload(const CPDF_Dictionary& dictionary,
                         BoundedArchive* output) {
  for (const auto& [key, value] : CPDF_DictionaryLocker(&dictionary)) {
    if (key == "Parent" || key == "Prev" || key == "Last") {
      continue;
    }
    if (!output->WriteString(key.AsStringView()) || !output->WriteByte(0) ||
        !value->WriteTo(output, nullptr)) {
      return false;
    }
  }
  return true;
}

bool SameOutlinePayload(const CPDF_Dictionary& actual,
                        const CPDF_Dictionary* expected) {
  if (!expected) {
    return false;
  }
  BoundedArchive actual_payload;
  BoundedArchive expected_payload;
  return WriteOutlinePayload(actual, &actual_payload) &&
         WriteOutlinePayload(*expected, &expected_payload) &&
         actual_payload.contents == expected_payload.contents;
}

const char* WalkOutline(CPDF_Document* document,
                        OutlineTree* tree,
                        const CPDF_Dictionary& parent,
                        int parent_index,
                        size_t depth) {
  auto current = parent.GetObjectFor("First");
  if (Absent(current.Get())) {
    return Absent(parent.GetObjectFor("Last").Get())
               ? nullptr
               : "The PDF outline has a last-item link but no first-item link.";
  }
  if (depth > kMaxDepth) {
    return "The PDF outline exceeds the supported nesting depth.";
  }
  const CPDF_Dictionary* previous = nullptr;
  while (!Absent(current.Get())) {
    if (!current->IsReference()) {
      return "The PDF outline contains a direct item without a stable object identity.";
    }
    const auto dictionary =
        document->GetOrParseIndirectObject(current->AsReference()->GetRefObjNum());
    auto item = dictionary && dictionary->IsDictionary() ? dictionary->GetMutableDict() : nullptr;
    if (!item || item->IsInline() || item->GetObjNum() == CPDF_Object::kInvalidObjNum) {
      return "The PDF outline contains a missing or invalid item.";
    }
    if (!tree->seen.insert(item.Get()).second) {
      return "The PDF outline contains a cycle or a shared item.";
    }
    if (tree->items.size() >= kMaxItems) {
      return "The PDF outline exceeds the supported item count.";
    }
    CheckBacklink(tree, *item, "Parent", &parent);
    CheckBacklink(tree, *item, "Prev", previous);
    const auto stored_id = item->GetStringFor(kStableIdKey);
    auto id = stored_id ? stored_id->GetUnicodeText().ToUTF8()
                        : ByteString::Format("pdf-outline:%u:%u",
                                             item->GetObjNum(), item->GetGenNum());
    if (!IsValidId(id) || !tree->ids.insert(id).second) {
      return "The PDF outline has invalid or duplicate item identities.";
    }
    const auto title = item->GetStringFor("Title");
    if (!title) {
      return "The PDF outline contains an invalid title.";
    }
    const int index = static_cast<int>(tree->items.size());
    tree->items.push_back({item, std::move(id), title->GetUnicodeText().ToUTF8(),
                           parent_index, LocalPage(document, item),
                           item->GetIntegerFor("Count") >= 0});
    if (const char* error = WalkOutline(document, tree, *item, index, depth + 1)) {
      return error;
    }
    previous = item.Get();
    current = item->GetObjectFor("Next");
  }
  CheckBacklink(tree, parent, "Last", previous);
  return nullptr;
}

const char* ReadOutline(CPDF_Document* document, OutlineTree* tree) {
  const auto catalog = document->GetMutableRoot();
  if (!catalog) {
    return "The PDF has no catalog.";
  }
  if (Absent(catalog->GetObjectFor("Outlines").Get())) {
    return nullptr;
  }
  const auto root = catalog->GetMutableDirectObjectFor("Outlines");
  if (!root || !root->IsDictionary()) {
    return "The PDF outline root is not a dictionary.";
  }
  tree->root = root->GetMutableDict();
  tree->seen.insert(tree->root.Get());
  if (const char* error = WalkOutline(document, tree, *tree->root, -1, 1)) {
    return error;
  }
  for (const auto& [actual, expected] : tree->stale_links) {
    if (!tree->seen.contains(actual.Get()) && actual->KeyExist("Title") &&
        !SameOutlinePayload(*actual, expected)) {
      return "The PDF outline links reference an item missing from its forward tree.";
    }
  }
  return nullptr;
}

void SetLocalPage(CPDF_Document* document,
                  CPDF_Dictionary& dictionary,
                  const CPDF_Dictionary& page) {
  auto dest = dictionary.SetNewFor<CPDF_Array>("Dest");
  dest->Append(page.MakeReference(document));
  dest->AppendNew<CPDF_Name>("Fit");
  dictionary.RemoveFor("A");
}

int RelinkOutline(CPDF_Document* document,
                  const std::vector<OutlineItem>& items,
                  const std::vector<std::vector<size_t>>& children,
                  CPDF_Dictionary& parent,
                  size_t parent_index) {
  const auto& siblings = children[parent_index];
  if (siblings.empty()) {
    parent.RemoveFor("First");
    parent.RemoveFor("Last");
    return 0;
  }
  parent.SetFor("First", items[siblings.front()].dict->MakeReference(document));
  parent.SetFor("Last", items[siblings.back()].dict->MakeReference(document));
  int visible = 0;
  for (size_t index = 0; index < siblings.size(); ++index) {
    const auto& item = items[siblings[index]];
    auto& dictionary = *item.dict;
    dictionary.SetFor("Parent", parent.MakeReference(document));
    if (index != 0) {
      dictionary.SetFor("Prev", items[siblings[index - 1]].dict->MakeReference(document));
    } else {
      dictionary.RemoveFor("Prev");
    }
    if (index + 1 < siblings.size()) {
      dictionary.SetFor("Next", items[siblings[index + 1]].dict->MakeReference(document));
    } else {
      dictionary.RemoveFor("Next");
    }
    const int descendants = RelinkOutline(document, items, children, dictionary, siblings[index]);
    if (descendants) {
      dictionary.SetNewFor<CPDF_Number>("Count", item.open ? descendants : -descendants);
    } else {
      dictionary.RemoveFor("Count");
    }
    visible += 1 + (item.open ? descendants : 0);
  }
  return visible;
}

struct ProjectedItem {
  size_t original;
  WideString id;
  WideString title;
  RetainPtr<const CPDF_Dictionary> page;
};

}  // namespace

FPDF_EXPORT const char* FPDF_CALLCONV
DSHPDF_VisitOutlines(FPDF_DOCUMENT document,
                    DSHPDF_OUTLINE_VISITOR visitor,
                    void* context) {
  auto* pdf = CPDFDocumentFromFPDFDocument(document);
  if (!pdf || !visitor) {
    return "Invalid PDF outline visitor.";
  }
  OutlineTree tree;
  if (const char* error = ReadOutline(pdf, &tree)) {
    return error;
  }
  for (const auto& item : tree.items) {
    visitor(context, item.id.c_str(), item.title.c_str(), item.title.GetLength(),
            item.parent, item.page);
  }
  return nullptr;
}

FPDF_EXPORT const char* FPDF_CALLCONV
DSHPDF_ApplyOutlines(FPDF_DOCUMENT document,
                    const DSHPDF_OUTLINE_EDIT* edits,
                    size_t count) {
  auto* pdf = CPDFDocumentFromFPDFDocument(document);
  if (!pdf || count > kMaxItems || (count != 0 && !edits)) {
    return "Invalid PDF outline projection.";
  }
  OutlineTree tree;
  if (const char* error = ReadOutline(pdf, &tree)) {
    return error;
  }
  std::map<ByteString, size_t> existing;
  for (size_t index = 0; index < tree.items.size(); ++index) {
    existing.emplace(tree.items[index].id, index);
  }
  std::set<ByteString> seen;
  std::vector<ProjectedItem> projected;
  std::vector<size_t> path;
  std::vector<std::vector<size_t>> children(count + 1);
  bool structural = tree.needs_relink || count != tree.items.size();
  for (size_t index = 0; index < count; ++index) {
    const auto& edit = edits[index];
    const auto parent = static_cast<size_t>(edit.parent_index);
    if (edit.parent_index < -1 || (edit.parent_index >= 0 && parent >= index)) {
      return "Invalid PDF outline parent index.";
    }
    while (!path.empty() && path.back() != parent) {
      path.pop_back();
    }
    if ((edit.parent_index >= 0 && path.empty()) || path.size() >= kMaxDepth) {
      return "Invalid PDF outline preorder or nesting depth.";
    }
    path.push_back(index);
    children[edit.parent_index == -1 ? count : parent].push_back(index);
    const ByteString id(edit.id);
    if (!IsValidId(id) || !seen.insert(id).second) {
      return "Invalid or duplicate PDF outline identity.";
    }
    const auto old = existing.find(id);
    const bool added = old == existing.end();
    if (added && (!edit.title || edit.page_index < 0)) {
      return "New PDF outline items require a title and destination.";
    }
    const auto wide_id = WideString::FromUTF8(id.AsStringView());
    if (wide_id.ToUTF8() != id) {
      return "The PDF outline identity is not valid UTF-8.";
    }
    const ByteString title(edit.title);
    auto wide_title = WideString::FromUTF8(title.AsStringView());
    if (edit.title && (wide_title.IsEmpty() || wide_title.ToUTF8() != title ||
                       wide_title.ToUTF16LE().GetLength() > (kMaxTitleUtf16 + 1) * 2)) {
      return "Invalid PDF outline title.";
    }
    if (edit.page_index < -1 || edit.page_index >= pdf->GetPageCount()) {
      return "The PDF outline destination does not exist.";
    }
    auto page = edit.page_index >= 0 ? pdf->GetPageDictionary(edit.page_index) : nullptr;
    if (edit.page_index >= 0 && (!page || page->IsInline())) {
      return "The PDF outline destination has no stable page identity.";
    }
    structural = structural || added || old->second != index ||
                 tree.items[old->second].parent != edit.parent_index;
    projected.push_back({added ? tree.items.size() : old->second, wide_id,
                         std::move(wide_title), std::move(page)});
  }

  std::vector<OutlineItem> items;
  for (size_t index = 0; index < projected.size(); ++index) {
    const auto& value = projected[index];
    const bool added = value.original == tree.items.size();
    auto item = added ? OutlineItem{pdf->NewIndirect<CPDF_Dictionary>(), {}, {}, -1, -1, true}
                      : tree.items[value.original];
    if (added) {
      item.dict->SetNewFor<CPDF_String>(kStableIdKey, value.id.AsStringView());
    }
    if (edits[index].title) {
      item.dict->SetNewFor<CPDF_String>("Title", value.title.AsStringView());
    }
    if (value.page) {
      SetLocalPage(pdf, *item.dict, *value.page);
    }
    items.push_back(std::move(item));
  }
  if (structural) {
    auto catalog = pdf->GetMutableRoot();
    if (!tree.root) {
      tree.root = pdf->NewIndirect<CPDF_Dictionary>();
      tree.root->SetNewFor<CPDF_Name>("Type", "Outlines");
      catalog->SetFor("Outlines", tree.root->MakeReference(pdf));
    } else if (tree.root->IsInline()) {
      catalog->ConvertToIndirectObjectFor("Outlines", pdf);
    }
    tree.root->SetNewFor<CPDF_Number>(
        "Count", RelinkOutline(pdf, items, children, *tree.root, count));
  }
  return nullptr;
}
