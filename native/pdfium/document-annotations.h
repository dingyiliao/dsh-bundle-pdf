#pragma once

struct Annotation {
  FPDF_ANNOTATION handle;
  explicit Annotation(FPDF_ANNOTATION value) : handle(value) {}
  Annotation(const Annotation&) = delete;
  Annotation& operator=(const Annotation&) = delete;
  ~Annotation() { if (handle) FPDFPage_CloseAnnot(handle); }
};

constexpr std::array<std::pair<FPDF_ANNOTATION_SUBTYPE, const char*>, 4> annotation_types{{
  {FPDF_ANNOT_TEXT, "Text"}, {FPDF_ANNOT_HIGHLIGHT, "Highlight"},
  {FPDF_ANNOT_UNDERLINE, "Underline"}, {FPDF_ANNOT_STRIKEOUT, "StrikeOut"},
}};

// PDF permissions bit 6 authorizes annotation changes independently of general editing.
constexpr unsigned int annotation_permission = 0x20;
constexpr int noneditable_annotation_flags = FPDF_ANNOT_FLAG_INVISIBLE | FPDF_ANNOT_FLAG_HIDDEN
  | FPDF_ANNOT_FLAG_NOVIEW | FPDF_ANNOT_FLAG_READONLY | FPDF_ANNOT_FLAG_LOCKED | (1 << 9);

bool can_edit_protected_annotations(Document& doc) {
  return FPDF_GetSecurityHandlerRevision(doc.handle) >= 0
    && doc.metadata.signature_status(doc.handle) == 0
    && (FPDF_GetDocPermissions(doc.handle) & annotation_permission) != 0;
}

void require_protected_annotation_access(Document& doc) {
  if (!can_edit_protected_annotations(doc))
    throw Failure("pdf/annotation-permission", "This credential does not permit protected PDF annotation editing");
}

bool can_edit_plain_document(Document& doc) {
  return FPDF_GetSecurityHandlerRevision(doc.handle) < 0 && doc.metadata.signature_status(doc.handle) == 0
    && doc.formType != FORMTYPE_XFA_FULL && doc.formType != FORMTYPE_XFA_FOREGROUND;
}

std::optional<std::string> annotation_string(FPDF_ANNOTATION annot, const char* key, size_t max_units) {
  if (!FPDFAnnot_HasKey(annot, key)) return std::nullopt;
  const auto bytes = FPDFAnnot_GetStringValue(annot, key, nullptr, 0);
  if (!bytes || bytes % 2 || bytes / 2 > max_units + 1) return std::nullopt;
  std::vector<FPDF_WCHAR> units(bytes / 2);
  if (FPDFAnnot_GetStringValue(annot, key, units.data(), bytes) != bytes) return std::nullopt;
  return utf8_text(units);
}

std::vector<FPDF_WCHAR> annotation_wide(const json& value, size_t max_units) {
  require(value.is_string(), "Annotation metadata must be text");
  const auto& text = value.get_ref<const std::string&>();
  require(text.find('\0') == std::string::npos, "Annotation text contains NUL");
  std::vector<FPDF_WCHAR> units;
  // nlohmann's JSON parser has already validated the UTF-8 sequence.
  for (size_t i = 0; i < text.size();) {
    const auto lead = static_cast<unsigned char>(text[i++]);
    const unsigned tail = lead < 0x80 ? 0 : lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : 3;
    uint32_t scalar = tail ? lead & (0x7f >> (tail + 1)) : lead;
    for (unsigned j = 0; j < tail; j++) {
      scalar = (scalar << 6) | (static_cast<unsigned char>(text[i++]) & 0x3f);
    }
    if (scalar >= 0x10000) {
      scalar -= 0x10000;
      units.push_back(static_cast<FPDF_WCHAR>(0xd800 + (scalar >> 10)));
      units.push_back(static_cast<FPDF_WCHAR>(0xdc00 + (scalar & 0x3ff)));
    } else units.push_back(static_cast<FPDF_WCHAR>(scalar));
  }
  require(units.size() <= max_units, "Annotation text exceeds its budget");
  units.push_back(0);
  return units;
}

constexpr std::array<std::pair<const char*, const char*>, 5> annotation_text_fields{{
  {"id", "DSHPDFId"}, {"contents", "Contents"}, {"author", "T"}, {"createdAt", "CreationDate"}, {"modifiedAt", "M"},
}};
size_t annotation_text_limit(std::string_view name) {
  return name == "contents" ? 100000 : name == "author" ? 1024 : name == "id" ? 200 : 128;
}

std::unordered_set<int> related_annotations(FPDF_PAGE page, int count) {
  std::unordered_set<int> related;
  for (int index = 0; index < count; index++) {
    Annotation annot(FPDFPage_GetAnnot(page, index));
    if (!annot.handle) continue;
    // A reply or popup may refer to a root with no outgoing link of its own.
    for (const char* key : {"IRT", "Parent", "Popup"}) {
      if (!FPDFAnnot_HasKey(annot.handle, key)) continue;
      related.insert(index);
      Annotation linked(FPDFAnnot_GetLinkedAnnot(annot.handle, key));
      if (linked.handle) {
        const int target = FPDFPage_GetAnnotIndex(page, linked.handle);
        if (target >= 0) related.insert(target);
      }
    }
  }
  return related;
}

bool annotation_rect_valid(const FS_RECTF& rect) {
  return std::isfinite(rect.left) && std::isfinite(rect.bottom) && std::isfinite(rect.right)
    && std::isfinite(rect.top) && rect.left < rect.right && rect.bottom < rect.top;
}

json describe_annotation(FPDF_ANNOTATION annot, int index, bool editable, Document* ordinary = nullptr) {
  const auto subtype = FPDFAnnot_GetSubtype(annot);
  const auto type = std::find_if(annotation_types.begin(), annotation_types.end(),
    [subtype](const auto& entry) { return entry.first == subtype; });
  const bool supported = type != annotation_types.end();
  if (!supported && !ordinary) return nullptr;
  const int flags = FPDFAnnot_GetFlags(annot);
  FS_RECTF rect{};
  const bool geometry = FPDFAnnot_GetRect(annot, &rect) && annotation_rect_valid(rect);
  if (!geometry && !ordinary) return nullptr;
  json result{{"index", index}, {"subtype", supported ? type->second : annotation_string(annot, "Subtype", 128).value_or("Unknown")},
    {"flags", std::max(0, flags)}};
  if (geometry) result["rect"] = {rect.left, rect.bottom, rect.right, rect.top};
  if (!ordinary) {
    editable = editable && !(flags & noneditable_annotation_flags)
      && !FPDFAnnot_HasKey(annot, "AP") && !FPDFAnnot_HasKey(annot, "RC");
  } else {
    constexpr auto locked = FPDF_ANNOT_FLAG_READONLY | FPDF_ANNOT_FLAG_LOCKED | (1 << 9);
    editable = editable && supported && geometry && !(flags & locked);
  }
  if (subtype != FPDF_ANNOT_TEXT && (supported || subtype == FPDF_ANNOT_LINK)) {
    const auto count = FPDFAnnot_CountAttachmentPoints(annot);
    json quads = json::array();
    if (count && count <= 4000) {
      for (size_t i = 0; i < count; i++) {
        FS_QUADPOINTSF q{};
        if (!FPDFAnnot_GetAttachmentPoints(annot, i, &q)) break;
        for (auto n : {q.x1, q.y1, q.x2, q.y2, q.x3, q.y3, q.x4, q.y4}) {
          quads.push_back(std::isfinite(n) ? json(n) : json(nullptr));
        }
      }
    }
    if (quads.size() == count * 8 && count && std::none_of(quads.begin(), quads.end(),
        [](const auto& value) { return value.is_null(); })) result["quadPoints"] = std::move(quads);
    else editable = false;
  }
  unsigned red = 0, green = 0, blue = 0, alpha = 0;
  if (FPDFAnnot_GetColor(annot, FPDFANNOT_COLORTYPE_Color, &red, &green, &blue, &alpha)
      && std::max({red, green, blue, alpha}) <= 255 && !ordinary) {
    result["color"] = {red / 255., green / 255., blue / 255.};
    result["opacity"] = alpha / 255.;
  }
  if (ordinary) {
    FPDF_DSH_ANNOTATION_DETAILS details{};
    if (!FPDF_DSH_GetAnnotationDetails(annot, &details)) return nullptr;
    const auto identity = [&](const void* object) {
      return ordinary->annotationObjects.try_emplace(object, ordinary->annotationObjects.size()).first->second;
    };
    result["object"] = identity(details.identity);
    if (details.object_number) result["referenceId"] = "ref:" + std::to_string(details.object_number) + ":" + std::to_string(details.generation);
    if (details.reply_type) result["replyType"] = details.reply_type;
    if (details.reply_parent) result["replyParent"] = identity(details.reply_parent);
    if (details.popup) result["popup"] = identity(details.popup);
    if (details.rich_text) result["hasRichText"] = true;
    if (details.has_color) result["color"] = {details.color[0], details.color[1], details.color[2]};
    if (details.has_opacity) result["opacity"] = details.opacity;
    if (details.has_comment_position) result["commentPosition"] = {details.comment_position.x, details.comment_position.y};
    constexpr std::array<const char*, 5> actions{{"", "FirstPage", "LastPage", "NextPage", "PrevPage"}};
    if (details.named_action > 0 && details.named_action < static_cast<int>(actions.size()))
      result["linkAction"] = actions[details.named_action];
  }
  for (const auto& [name, key] : annotation_text_fields) {
    if (auto value = annotation_string(annot, key, annotation_text_limit(name))) {
      result[name] = std::move(*value);
    } else if (FPDFAnnot_HasKey(annot, key)) editable = false;
  }
  result["editable"] = editable;
  return result;
}

// Limit relationship discovery and metadata independently of the PDF byte cap.
constexpr int max_editable_page_annotations = 4096;

json read_annotations(Document& doc, const json& request) {
  const bool ordinary = FPDF_GetSecurityHandlerRevision(doc.handle) < 0;
  const int page_index = integer(request, "pageIndex", 0, doc.count - 1);
  auto page = doc.page(page_index);
  const auto count = FPDFPage_GetAnnotCount(page);
  const int start = integer(request, "offset", 0, count);
  const int limit = integer(request, "limit", 1, 64);
  const bool editable = (ordinary ? can_edit_plain_document(doc) : can_edit_protected_annotations(doc))
    && count <= max_editable_page_annotations;
  const auto related = editable && !ordinary ? related_annotations(page, count) : std::unordered_set<int>{};
  json items = json::array();
  size_t budget = max_json - 4096;
  int index = start;
  for (; index < count && index - start < limit; index++) {
    Annotation annot(FPDFPage_GetAnnot(page, index));
    if (!annot.handle) continue;
    auto item = describe_annotation(annot.handle, index, editable && !related.count(index), ordinary ? &doc : nullptr);
    if (item.is_null()) continue;
    const auto size = item.dump().size() + 1;
    if (size > budget) {
      require(!items.empty(), "A protected annotation exceeds the metadata budget");
      break;
    }
    budget -= size;
    items.push_back(std::move(item));
  }
  return {{"annotations", std::move(items)}, {"nextOffset", index < count ? json(index) : json(nullptr)}};
}

float annotation_number(const json& value, double minimum, double maximum) {
  require(value.is_number(), "Annotation geometry or color must be numeric");
  const auto number = value.get<double>();
  require(number >= minimum && number <= maximum, "Annotation geometry or color exceeds its bounds");
  return static_cast<float>(number);
}

float annotation_coordinate(const json& value) {
  return annotation_number(value, -1e8, 1e8);
}

FS_RECTF annotation_rectangle(const json& value) {
  require(value.is_array() && value.size() == 4, "Annotation rectangle requires four coordinates");
  const FS_RECTF rect{annotation_coordinate(value[0]), annotation_coordinate(value[3]),
    annotation_coordinate(value[2]), annotation_coordinate(value[1])};
  require(annotation_rect_valid(rect), "Annotation rectangle has no area");
  return rect;
}

void annotation_write_failed(bool ok) {
  if (!ok) throw Failure("pdf/native-annotation", "PDFium could not apply the annotation edit");
}

void write_annotation_color(FPDF_ANNOTATION annot, const json& value, float opacity) {
  require(value.is_array() && value.size() == 3, "Annotation color requires three channels");
  const auto channel = [](float number) { return static_cast<unsigned int>(std::lround(number * 255)); };
  annotation_write_failed(FPDFAnnot_SetColor(annot, FPDFANNOT_COLORTYPE_Color,
    channel(annotation_number(value[0], 0, 1)), channel(annotation_number(value[1], 0, 1)),
    channel(annotation_number(value[2], 0, 1)), channel(opacity)));
}

void write_annotation_quads(FPDF_ANNOTATION annot, const json& value, const FS_RECTF& rect) {
  require(value.is_array() && !value.empty() && value.size() % 8 == 0 && value.size() <= 32000,
    "Text markup needs bounded quadrilaterals");
  for (size_t index = 0; index < value.size(); index += 8) {
    std::array<float, 8> n{};
    for (size_t j = 0; j < n.size(); j++) {
      n[j] = annotation_coordinate(value[index + j]);
      const auto low = j % 2 ? rect.bottom : rect.left;
      const auto high = j % 2 ? rect.top : rect.right;
      require(n[j] >= low - 0.01 && n[j] <= high + 0.01, "Text markup extends outside its rectangle");
    }
    require(std::abs((n[2] - n[0]) * (n[5] - n[1]) - (n[3] - n[1]) * (n[4] - n[0])) >= 1e-6,
      "Text markup quadrilateral has no area");
    const FS_QUADPOINTSF quad{n[0], n[1], n[2], n[3], n[4], n[5], n[6], n[7]};
    annotation_write_failed(FPDFAnnot_AppendAttachmentPoints(annot, &quad));
  }
}

void write_annotation_string(FPDF_ANNOTATION annot, const char* key, const json& value, size_t max_units) {
  const auto units = annotation_wide(value, max_units);
  annotation_write_failed(FPDFAnnot_SetStringValue(annot, key, units.data()));
}

void write_comment_position(FPDF_ANNOTATION annot, const json& value) {
  require(value.is_array() && value.size() == 2, "Invalid comment position");
  const FS_POINTF position{annotation_coordinate(value[0]), annotation_coordinate(value[1])};
  annotation_write_failed(FPDF_DSH_SetCommentPosition(annot, &position));
}

void write_ordinary_appearance(FPDF_ANNOTATION annot, const FS_RECTF& rect, const json& color,
  float opacity, const json& quads, bool write_color = true) {
  require(color.is_array() && color.size() == 3, "Annotation color requires three channels");
  const std::array<float, 3> rgb{annotation_number(color[0], 0, 1),
    annotation_number(color[1], 0, 1), annotation_number(color[2], 0, 1)};
  const float width = rect.right - rect.left, height = rect.top - rect.bottom;
  const auto type = FPDFAnnot_GetSubtype(annot);
  std::ostringstream paint;
  paint.imbue(std::locale::classic());
  paint << std::fixed << std::setprecision(5);
  const auto at = [&](float x, float y) { paint << x - rect.left << ' ' << y - rect.bottom; };
  paint << rgb[0] << ' ' << rgb[1] << ' ' << rgb[2] << " rg\n"
    << rgb[0] << ' ' << rgb[1] << ' ' << rgb[2] << " RG\n";
  if (type == FPDF_ANNOT_TEXT) {
    paint << "0.7 w 0.5 0.5 " << std::max(0.f, width - 1) << ' ' << std::max(0.f, height - 1)
      << " re B\n0.2 0.2 0.2 RG\n";
    for (float ratio : {0.3f, 0.5f, 0.7f})
      paint << width * 0.22f << ' ' << height * ratio << " m "
        << width * 0.78f << ' ' << height * ratio << " l S\n";
  } else {
    for (size_t offset = 0; offset < quads.size(); offset += 8) {
      std::array<float, 8> q{};
      for (size_t i = 0; i < q.size(); ++i) q[i] = quads[offset + i].get<float>();
      if (type == FPDF_ANNOT_HIGHLIGHT) {
        at(q[0], q[1]); paint << " m ";
        at(q[2], q[3]); paint << " l ";
        at(q[6], q[7]); paint << " l ";
        at(q[4], q[5]); paint << " l h f\n";
      } else {
        const auto ratio = type == FPDF_ANNOT_STRIKEOUT ? 0.5f : 0.06f;
        paint << std::max(0.5f, std::hypot(q[0] - q[4], q[1] - q[5]) * 0.065f) << " w ";
        at(q[4] + (q[0] - q[4]) * ratio, q[5] + (q[1] - q[5]) * ratio); paint << " m ";
        at(q[6] + (q[2] - q[6]) * ratio, q[7] + (q[3] - q[7]) * ratio); paint << " l S\n";
      }
    }
  }
  const auto commands = paint.str();
  annotation_write_failed(FPDF_DSH_SetAnnotationAppearance(annot, commands.data(), commands.size(),
    write_color ? rgb.data() : nullptr, opacity, type == FPDF_ANNOT_HIGHLIGHT));
}

void add_annotation(FPDF_PAGE page, int index, const json& value, bool ordinary) {
  const auto name = value.at("subtype").get<std::string>();
  const auto type = std::find_if(annotation_types.begin(), annotation_types.end(),
    [&](const auto& entry) { return entry.second == name; });
  require(type != annotation_types.end(), "Unsupported protected annotation subtype");
  const auto rect = annotation_rectangle(value.at("rect"));
  const auto id = annotation_wide(value.at("id"), annotation_text_limit("id"));
  require(id.size() > 1, "Protected annotations require an identity");
  Annotation annot(FPDFPage_CreateAnnot(page, type->first));
  annotation_write_failed(annot.handle != nullptr);
  try {
    annotation_write_failed(FPDFAnnot_SetRect(annot.handle, &rect));
    annotation_write_failed(FPDFAnnot_SetFlags(annot.handle, FPDF_ANNOT_FLAG_PRINT));
    const auto opacity = value.contains("opacity") ? annotation_number(value["opacity"], 0, 1)
      : type->first == FPDF_ANNOT_HIGHLIGHT ? 0.4f : 1.f;
    const auto color = value.value("color", json::array({1., 0.85, 0.}));
    if (type->first != FPDF_ANNOT_TEXT) write_annotation_quads(annot.handle, value.at("quadPoints"), rect);
    annotation_write_failed(FPDFAnnot_SetStringValue(annot.handle, "NM", id.data()));
    for (const auto& [field, key] : annotation_text_fields) {
      if (value.contains(field)) write_annotation_string(annot.handle, key, value[field], annotation_text_limit(field));
    }
    if (ordinary) {
      if (value.contains("replyParentIndex")) {
        Annotation parent(FPDFPage_GetAnnot(page, integer(value, "replyParentIndex", 0, index - 1)));
        // A reply has no painted appearance. An empty form also prevents
        // PDFium from generating a sticky icon and expanding its Rect.
        require(color.is_array() && color.size() == 3, "Annotation color requires three channels");
        const std::array<float, 3> rgb{annotation_number(color[0], 0, 1),
          annotation_number(color[1], 0, 1), annotation_number(color[2], 0, 1)};
        constexpr std::string_view empty = "q Q";
        annotation_write_failed(FPDF_DSH_SetAnnotationAppearance(annot.handle, empty.data(), empty.size(),
          rgb.data(), opacity, false));
        annotation_write_failed(FPDF_DSH_SetAnnotationReply(page, annot.handle, parent.handle));
      } else {
        write_ordinary_appearance(annot.handle, rect, color, opacity, value.value("quadPoints", json::array()));
      }
      if (value.contains("commentPosition")) write_comment_position(annot.handle, value["commentPosition"]);
    } else
    {
      write_annotation_color(annot.handle, color, opacity);
    }
  } catch (...) {
    FPDFPage_RemoveAnnot(page, index);
    throw;
  }
}

json edit_annotation(Document& doc, const json& request) {
  const bool ordinary = can_edit_plain_document(doc);
  if (!ordinary) require_protected_annotation_access(doc);
  auto page = doc.page(integer(request, "pageIndex", 0, doc.count - 1));
  const int count = FPDFPage_GetAnnotCount(page);
  require(count <= max_editable_page_annotations, "Page annotation count exceeds the edit budget");
  const auto action = request.at("action").get<std::string>();
  require(action == "add" || action == "update" || action == "delete", "Unknown protected annotation edit");
  doc.metadata.clear_fingerprints();
  doc.saved.clear();
  if (action == "add") {
    add_annotation(page, count, request.at("annotation"), ordinary);
    if (ordinary) return {{"changed", true}, {"index", count}};
  } else {
    const int index = integer(request, "annotationIndex", 0, count - 1);
    Annotation annot(FPDFPage_GetAnnot(page, index));
    const auto metadata = annot.handle ? describe_annotation(annot.handle, index,
      ordinary || !related_annotations(page, count).count(index), ordinary ? &doc : nullptr) : json(nullptr);
    const bool associated_popup = ordinary && action == "delete" && request.value("associatedPopup", false)
      && annot.handle && FPDFAnnot_GetSubtype(annot.handle) == FPDF_ANNOT_POPUP;
    if (metadata.is_null() || (!metadata.at("editable").get<bool>() && !associated_popup))
      throw Failure("pdf/annotation-read-only", "Protected annotation cannot be edited safely");
    if (action == "delete") {
      annotation_write_failed(FPDFPage_RemoveAnnot(page, index));
    } else {
      const auto& patch = request.at("patch");
      require(patch.is_object(), "Annotation patch must be an object");
      if (patch.contains("rect")) {
        require(FPDFAnnot_GetSubtype(annot.handle) == FPDF_ANNOT_TEXT, "Only protected notes may be repositioned");
        const auto rect = annotation_rectangle(patch["rect"]);
        annotation_write_failed(FPDFAnnot_SetRect(annot.handle, &rect));
      }
      if (ordinary) {
        if (patch.contains("id")) write_annotation_string(annot.handle, "DSHPDFId", patch["id"], annotation_text_limit("id"));
        if (patch.contains("contents")) {
          const auto text = annotation_wide(patch["contents"], annotation_text_limit("contents"));
          annotation_write_failed(FPDF_DSH_SetAnnotationContents(annot.handle, text.data()));
        }
        if (patch.contains("commentPosition")) {
          write_comment_position(annot.handle, patch["commentPosition"]);
        }
        if (patch.contains("color") || patch.contains("rect")) {
          const auto color = patch.value("color", metadata.value("color", json::array({1., 0.85, 0.})));
          const auto opacity = std::clamp(metadata.value("opacity",
            FPDFAnnot_GetSubtype(annot.handle) == FPDF_ANNOT_HIGHLIGHT ? 0.4f : 1.f), 0.f, 1.f);
          const auto rect = annotation_rectangle(patch.value("rect", metadata.at("rect")));
          write_ordinary_appearance(annot.handle, rect, color, opacity,
            metadata.value("quadPoints", json::array()), patch.contains("color"));
        }
      } else
      {
        if (patch.contains("color")) write_annotation_color(annot.handle, patch["color"], metadata.value("opacity", 1.f));
        if (patch.contains("contents")) write_annotation_string(annot.handle, "Contents", patch["contents"], annotation_text_limit("contents"));
      }
      if (patch.contains("modifiedAt")) write_annotation_string(annot.handle, "M", patch["modifiedAt"], annotation_text_limit("modifiedAt"));
    }
  }
  return {{"changed", true}};
}

