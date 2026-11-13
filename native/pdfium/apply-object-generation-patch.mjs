/** Keep PDF object identities intact across PDFium serialization. */
export async function applyObjectGenerationPatch(replaceOnce) {
  const parser = 'core/fpdfapi/parser/'
  const referenceHeader = parser + 'cpdf_reference.h'
  const reference = parser + 'cpdf_reference.cpp'
  await replaceOnce(referenceHeader, '#include <set>', '#include <optional>\n#include <set>')
  await replaceOnce(referenceHeader,
    '  CPDF_Reference(CPDF_IndirectObjectHolder* doc, uint32_t objnum);',
    `  CPDF_Reference(CPDF_IndirectObjectHolder* doc,
                 uint32_t objnum,
                 std::optional<uint32_t> ref_generation = std::nullopt);`)
  await replaceOnce(referenceHeader, '  uint32_t ref_obj_num_;',
    `  uint32_t ref_obj_num_;
  // Parsed references retain the generation declared in the input. An
  // engine-created reference resolves the current target when serialized.
  std::optional<uint32_t> ref_generation_;`)
  await replaceOnce(reference,
    `CPDF_Reference::CPDF_Reference(CPDF_IndirectObjectHolder* doc, uint32_t objnum)
    : obj_list_(doc), ref_obj_num_(objnum) {}`,
    `CPDF_Reference::CPDF_Reference(CPDF_IndirectObjectHolder* doc,
                               uint32_t objnum,
                               std::optional<uint32_t> ref_generation)
    : obj_list_(doc), ref_obj_num_(objnum), ref_generation_(ref_generation) {}`)
  await replaceOnce(reference, 'pdfium::MakeRetain<CPDF_Reference>(obj_list_, ref_obj_num_)',
    'pdfium::MakeRetain<CPDF_Reference>(obj_list_, ref_obj_num_, ref_generation_)')
  await replaceOnce(reference, '  ref_obj_num_ = objnum;\n}',
    '  ref_obj_num_ = objnum;\n  ref_generation_.reset();\n}')
  await replaceOnce(reference,
    `  return archive->WriteString(" ") && archive->WriteDWord(GetRefObjNum()) &&
         archive->WriteString(" 0 R ");`,
    `  uint32_t generation = 0;
  if (ref_generation_) {
    generation = *ref_generation_;
  } else if (obj_list_) {
    const CPDF_Object* target =
        obj_list_->GetOrParseIndirectObjectInternal(ref_obj_num_);
    if (target) {
      generation = target->GetGenNum();
    }
  }
  return generation <= UINT16_MAX && archive->WriteString(" ") &&
         archive->WriteDWord(GetRefObjNum()) && archive->WriteString(" ") &&
         archive->WriteDWord(generation) && archive->WriteString(" R ");`)
  await replaceOnce(reference, 'pdfium::MakeRetain<CPDF_Reference>(holder, GetRefObjNum())',
    'pdfium::MakeRetain<CPDF_Reference>(holder, GetRefObjNum(), ref_generation_)')
  await replaceOnce(parser + 'cpdf_syntax_parser.cpp',
    '    return pdfium::MakeRetain<CPDF_Reference>(pObjList, refnum);',
    `    return pdfium::MakeRetain<CPDF_Reference>(
        pObjList, refnum, FXSYS_atoui(nextword.word.c_str()));`)

  const encryptorHeader = parser + 'cpdf_encryptor.h'
  const encryptor = parser + 'cpdf_encryptor.cpp'
  await replaceOnce(encryptorHeader, '  CPDF_Encryptor(const CPDF_CryptoHandler* pHandler, int objnum);',
    `  CPDF_Encryptor(const CPDF_CryptoHandler* pHandler,
                 uint32_t objnum,
                 uint32_t generation);`)
  await replaceOnce(encryptorHeader, '  const int obj_num_;',
    '  const uint32_t obj_num_;\n  const uint32_t generation_;')
  await replaceOnce(encryptor,
    `CPDF_Encryptor::CPDF_Encryptor(const CPDF_CryptoHandler* pHandler, int objnum)
    : handler_(pHandler), obj_num_(objnum) {`,
    `CPDF_Encryptor::CPDF_Encryptor(const CPDF_CryptoHandler* pHandler,
                               uint32_t objnum,
                               uint32_t generation)
    : handler_(pHandler), obj_num_(objnum), generation_(generation) {`)
  await replaceOnce(encryptor, 'handler_->EncryptContent(obj_num_, 0, src_data)',
    'handler_->EncryptContent(obj_num_, generation_, src_data)')

  await replaceOnce(parser + 'cpdf_parser.h',
    '  FX_FILESIZE GetObjectPositionOrZero(uint32_t objnum) const;',
    `  FX_FILESIZE GetObjectPositionOrZero(uint32_t objnum) const;
  uint16_t GetObjectGenerationOrZero(uint32_t objnum) const;`)
  await replaceOnce(parser + 'cpdf_parser.cpp', 'bool CPDF_Parser::IsObjectFree(uint32_t objnum) const {',
    `uint16_t CPDF_Parser::GetObjectGenerationOrZero(uint32_t objnum) const {
  const auto* info = cross_ref_table_->GetObjectInfo(objnum);
  return info ? info->gennum : 0;
}

bool CPDF_Parser::IsObjectFree(uint32_t objnum) const {`)

  const creatorHeader = 'core/fpdfapi/edit/cpdf_creator.h'
  const creator = 'core/fpdfapi/edit/cpdf_creator.cpp'
  await replaceOnce(creatorHeader, '  bool WriteIndirectObj(uint32_t objnum, const CPDF_Object* pObj);',
    `  bool WriteIndirectObj(uint32_t objnum,
                        uint32_t generation,
                        const CPDF_Object* object);
  bool WriteCrossRefTableEntry(uint32_t objnum);`)
  await replaceOnce(creatorHeader, '  std::map<uint32_t, FX_FILESIZE> object_offsets_;',
    `  struct ObjectLocation {
    FX_FILESIZE offset;
    uint32_t generation;
  };
  std::map<uint32_t, ObjectLocation> object_locations_;`)
  await replaceOnce(creator, '#include <stdint.h>', '#include <inttypes.h>\n#include <stdint.h>')
  await replaceOnce(creator, '#include <array>', '#include <array>\n#include <limits>')
  await replaceOnce(creator,
    `bool OutputIndex(IFX_ArchiveStream* archive, FX_FILESIZE offset) {
  return archive->WriteByte(static_cast<uint8_t>(offset >> 24)) &&
         archive->WriteByte(static_cast<uint8_t>(offset >> 16)) &&
         archive->WriteByte(static_cast<uint8_t>(offset >> 8)) &&
         archive->WriteByte(static_cast<uint8_t>(offset)) &&
         archive->WriteByte(0);
}`,
    `bool OutputIndex(IFX_ArchiveStream* archive,
                 FX_FILESIZE offset,
                 uint32_t generation) {
  return offset >= 0 &&
         static_cast<uint64_t>(offset) <= std::numeric_limits<uint32_t>::max() &&
         archive->WriteByte(static_cast<uint8_t>(offset >> 24)) &&
         archive->WriteByte(static_cast<uint8_t>(offset >> 16)) &&
         archive->WriteByte(static_cast<uint8_t>(offset >> 8)) &&
         archive->WriteByte(static_cast<uint8_t>(offset)) &&
         archive->WriteByte(static_cast<uint8_t>(generation >> 8)) &&
         archive->WriteByte(static_cast<uint8_t>(generation));
}`)
  await replaceOnce(creator,
    `bool CPDF_Creator::WriteIndirectObj(uint32_t objnum, const CPDF_Object* pObj) {
  if (!archive_->WriteDWord(objnum) || !archive_->WriteString(" 0 obj\\r\\n")) {
    return false;
  }

  std::unique_ptr<CPDF_Encryptor> encryptor;
  if (GetCryptoHandler() && pObj != encrypt_dict_) {
    encryptor = std::make_unique<CPDF_Encryptor>(GetCryptoHandler(), objnum);
  }

  if (!pObj->WriteTo(archive_.get(), encryptor.get())) {`,
    `bool CPDF_Creator::WriteIndirectObj(uint32_t objnum,
                                    uint32_t generation,
                                    const CPDF_Object* object) {
  if (generation > UINT16_MAX) {
    return false;
  }
  object_locations_[objnum] = {archive_->CurrentOffset(), generation};
  if (!archive_->WriteDWord(objnum) || !archive_->WriteString(" ") ||
      !archive_->WriteDWord(generation) ||
      !archive_->WriteString(" obj\\r\\n")) {
    return false;
  }

  std::unique_ptr<CPDF_Encryptor> encryptor;
  if (GetCryptoHandler() && object != encrypt_dict_) {
    encryptor = std::make_unique<CPDF_Encryptor>(GetCryptoHandler(), objnum,
                                                generation);
  }

  if (!object->WriteTo(archive_.get(), encryptor.get())) {`)
  await replaceOnce(creator, 'bool CPDF_Creator::WriteOldIndirectObject(uint32_t objnum) {',
    `bool CPDF_Creator::WriteCrossRefTableEntry(uint32_t objnum) {
  const auto it = object_locations_.find(objnum);
  if (it == object_locations_.end() || it->second.offset < 0 ||
      it->second.offset > INT64_C(9999999999)) {
    return false;
  }
  const auto& location = it->second;
  const auto entry = ByteString::Format(
      "%010" PRId64 " %05" PRIu32 " n\\r\\n",
      static_cast<int64_t>(location.offset), location.generation);
  return archive_->WriteString(entry.AsStringView());
}

bool CPDF_Creator::WriteOldIndirectObject(uint32_t objnum) {`)
  await replaceOnce(creator,
    '  object_offsets_[objnum] = archive_->CurrentOffset();\n\n  bool bExistInMap = !!document_->GetIndirectObject(objnum);',
    '  const bool already_loaded = !!document_->GetIndirectObject(objnum);')
  await replaceOnce(creator, '  if (!bExistInMap) {', '  if (!already_loaded) {')
  await replaceOnce(creator,
    `  if (!pObj) {
    object_offsets_.erase(objnum);
    return true;
  }
  if (!WriteIndirectObj(pObj->GetObjNum(), pObj.Get())) {`,
    `  if (!pObj) {
    return true;
  }
  if (!WriteIndirectObj(objnum, pObj->GetGenNum(), pObj.Get())) {`)
  await replaceOnce(creator,
    '    object_offsets_[objnum] = archive_->CurrentOffset();\n\n    auto it = font_obj_overrides.find(objnum);',
    '    const auto it = font_obj_overrides.find(objnum);')
  await replaceOnce(creator, '    if (!WriteIndirectObj(objnum, obj_to_write)) {',
    '    if (!WriteIndirectObj(objnum, obj->GetGenNum(), obj_to_write)) {')
  await replaceOnce(creator, '        object_offsets_[num] = parser_->GetObjectPositionOrZero(num);',
    `        const FX_FILESIZE offset = parser_->GetObjectPositionOrZero(num);
        if (offset <= 0) {
          return Stage::kInvalid;
        }
        object_locations_[num] = {offset, parser_->GetObjectGenerationOrZero(num)};`)
  await replaceOnce(creator,
    `      FX_FILESIZE saveOffset = archive_->CurrentOffset();
      if (!WriteIndirectObj(last_obj_num_, encrypt_dict_.Get())) {
        return Stage::kInvalid;
      }

      object_offsets_[last_obj_num_] = saveOffset;`,
    `      if (!WriteIndirectObj(last_obj_num_, 0, encrypt_dict_.Get())) {
        return Stage::kInvalid;
      }`)
  await replaceOnce(creator, 'pdfium::Contains(object_offsets_, 1)', 'pdfium::Contains(object_locations_, 1)')
  await replaceOnce(creator, 'while (i <= dwLastObjNum && !pdfium::Contains(object_offsets_, i))',
    'while (i <= dwLastObjNum && !pdfium::Contains(object_locations_, i))')
  await replaceOnce(creator, 'pdfium::Contains(object_offsets_, j)', 'pdfium::Contains(object_locations_, j)')
  await replaceOnce(creator,
    `        str = ByteString::Format("%010d 00000 n\\r\\n", object_offsets_[i++]);
        if (!archive_->WriteString(str.AsStringView())) {`,
    `        if (!WriteCrossRefTableEntry(i++)) {`)
  await replaceOnce(creator,
    `        str = ByteString::Format("%010d 00000 n\\r\\n", object_offsets_[objnum]);
        if (!archive_->WriteString(str.AsStringView())) {`,
    `        if (!WriteCrossRefTableEntry(objnum)) {`)
  await replaceOnce(creator, '  bool bXRefStream = is_incremental_ && parser_->IsXRefStream();',
    `  const bool bXRefStream = is_incremental_ && parser_->IsXRefStream();
  const uint32_t xref_objnum = last_obj_num_ + 1;`)
  await replaceOnce(creator, '    if (!archive_->WriteDWord(document_->GetLastObjNum() + 1) ||',
    '    if (!archive_->WriteDWord(xref_objnum) ||')
  await replaceOnce(creator,
    `        !archive_->WriteDWord(document_->GetRoot()->GetObjNum()) ||
        !archive_->WriteString(" 0 R\\r\\n")) {`,
    `        !archive_->WriteDWord(document_->GetRoot()->GetObjNum()) ||
        !archive_->WriteString(" ") ||
        !archive_->WriteDWord(document_->GetRoot()->GetGenNum()) ||
        !archive_->WriteString(" R\\r\\n")) {`)
  await replaceOnce(creator,
    `          !archive_->WriteDWord(document_->GetInfo()->GetObjNum()) ||
          !archive_->WriteString(" 0 R\\r\\n")) {`,
    `          !archive_->WriteDWord(document_->GetInfo()->GetObjNum()) ||
          !archive_->WriteString(" ") ||
          !archive_->WriteDWord(document_->GetInfo()->GetGenNum()) ||
          !archive_->WriteString(" R\\r\\n")) {`)
  await replaceOnce(creator,
    `      dwObjNum = document_->GetLastObjNum() + 1;
    }
    if (!archive_->WriteString(" ") || !archive_->WriteDWord(dwObjNum) ||
        !archive_->WriteString(" 0 R ")) {`,
    `      dwObjNum = last_obj_num_;
    }
    const auto location = object_locations_.find(dwObjNum);
    const uint32_t generation = location != object_locations_.end()
                                    ? location->second.generation
                                    : encrypt_dict_->GetGenNum();
    if (!archive_->WriteString(" ") || !archive_->WriteDWord(dwObjNum) ||
        !archive_->WriteString(" ") || !archive_->WriteDWord(generation) ||
        !archive_->WriteString(" R ")) {`)
  await replaceOnce(creator,
    `    if (!archive_->WriteString("/W[0 4 1]/Index[")) {
      return Stage::kInvalid;
    }
    if (is_incremental_ && parser_ && parser_->GetLastXRefOffset() == 0) {
      uint32_t i = 0;
      for (i = 0; i < last_obj_num_; i++) {
        if (!pdfium::Contains(object_offsets_, i)) {
          continue;
        }
        if (!archive_->WriteDWord(i) || !archive_->WriteString(" 1 ")) {
          return Stage::kInvalid;
        }
      }
      if (!archive_->WriteString("]/Length ") ||
          !archive_->WriteDWord(last_obj_num_ * 5) ||
          !archive_->WriteString(">>stream\\r\\n")) {
        return Stage::kInvalid;
      }
      for (i = 0; i < last_obj_num_; i++) {
        auto it = object_offsets_.find(i);
        if (it == object_offsets_.end()) {
          continue;
        }
        if (!OutputIndex(archive_.get(), it->second)) {
          return Stage::kInvalid;
        }
      }
    } else {
      int count = fxcrt::CollectionSize<int>(new_obj_num_array_);
      int i = 0;
      for (i = 0; i < count; i++) {
        if (!archive_->WriteDWord(new_obj_num_array_[i]) ||
            !archive_->WriteString(" 1 ")) {
          return Stage::kInvalid;
        }
      }
      if (!archive_->WriteString("]/Length ") ||
          !archive_->WriteDWord(count * 5) ||
          !archive_->WriteString(">>stream\\r\\n")) {
        return Stage::kInvalid;
      }
      for (i = 0; i < count; ++i) {
        if (!OutputIndex(archive_.get(),
                         object_offsets_[new_obj_num_array_[i]])) {
          return Stage::kInvalid;
        }
      }
    }`,
    `    constexpr uint32_t kEntryWidth = 6;
    object_locations_[xref_objnum] = {xref_start_, 0};
    if (!archive_->WriteString("/W[0 4 2]/Index[")) {
      return Stage::kInvalid;
    }
    for (const auto& [objnum, location] : object_locations_) {
      if (!archive_->WriteDWord(objnum) || !archive_->WriteString(" 1 ")) {
        return Stage::kInvalid;
      }
    }
    if (!archive_->WriteString("]/Length ") ||
        !archive_->WriteDWord(
            fxcrt::CollectionSize<uint32_t>(object_locations_) * kEntryWidth) ||
        !archive_->WriteString(">>stream\\r\\n")) {
      return Stage::kInvalid;
    }
    for (const auto& [objnum, location] : object_locations_) {
      if (!OutputIndex(archive_.get(), location.offset, location.generation)) {
        return Stage::kInvalid;
      }
    }`)
  await replaceOnce(creator, '  object_offsets_.clear();', '  object_locations_.clear();')
}
