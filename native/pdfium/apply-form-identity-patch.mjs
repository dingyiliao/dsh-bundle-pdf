/** Let the DSH AcroForm adapter use PDF object identity in PDFium's existing
 * field/control model. The normal PDFium SDK keeps its name-based behavior. */
export async function applyFormIdentityPatch(replaceOnce) {
  const coreHeader = 'core/fpdfdoc/cpdf_interactiveform.h'
  const coreSource = 'core/fpdfdoc/cpdf_interactiveform.cpp'
  const sdkHeader = 'fpdfsdk/cpdfsdk_interactiveform.h'
  const sdkSource = 'fpdfsdk/cpdfsdk_interactiveform.cpp'
  const envHeader = 'fpdfsdk/cpdfsdk_formfillenvironment.h'
  const envSource = 'fpdfsdk/cpdfsdk_formfillenvironment.cpp'

  await replaceOnce(coreHeader,
    '  explicit CPDF_InteractiveForm(CPDF_Document* document);',
    '  explicit CPDF_InteractiveForm(CPDF_Document* document,\n                                bool distinct_fields = false);')
  await replaceOnce(coreHeader,
    '  std::unique_ptr<CFieldTree> field_tree_;',
    `  std::unique_ptr<CFieldTree> field_tree_;
  const bool distinct_fields_;
  std::vector<RetainPtr<CPDF_FormField>> object_fields_;
  std::map<const CPDF_Dictionary*, CPDF_FormField*> fields_by_dict_;`)
  await replaceOnce(coreSource,
    `CPDF_InteractiveForm::CPDF_InteractiveForm(CPDF_Document* document)
    : document_(document), field_tree_(std::make_unique<CFieldTree>()) {`,
    `CPDF_InteractiveForm::CPDF_InteractiveForm(CPDF_Document* document,
                                           bool distinct_fields)
    : document_(document),
      field_tree_(std::make_unique<CFieldTree>()),
      distinct_fields_(distinct_fields) {`)
  await replaceOnce(coreSource,
    `size_t CPDF_InteractiveForm::CountFields(const WideString& field_name) const {
  if (field_name.IsEmpty()) {`,
    `size_t CPDF_InteractiveForm::CountFields(const WideString& field_name) const {
  if (distinct_fields_) {
    if (field_name.IsEmpty()) {
      return object_fields_.size();
    }
    return std::count_if(object_fields_.begin(), object_fields_.end(),
                         [&field_name](const auto& field) {
                           return field->GetFullName() == field_name;
                         });
  }
  if (field_name.IsEmpty()) {`)
  await replaceOnce(coreSource,
    `    const WideString& field_name) const {
  if (field_name.IsEmpty()) {
    return field_tree_->GetRoot()->GetFieldAtIndex(index);`,
    `    const WideString& field_name) const {
  if (distinct_fields_) {
    if (field_name.IsEmpty()) {
      return index < object_fields_.size() ? object_fields_[index].Get()
                                           : nullptr;
    }
    for (const auto& field : object_fields_) {
      if (field->GetFullName() == field_name && index-- == 0) {
        return field.Get();
      }
    }
    return nullptr;
  }
  if (field_name.IsEmpty()) {
    return field_tree_->GetRoot()->GetFieldAtIndex(index);`)
  await replaceOnce(coreSource,
    '  return field_tree_->GetField(CPDF_FormField::GetFullNameForDict(field_dict));',
    `  if (distinct_fields_) {
    const auto found = fields_by_dict_.find(field_dict);
    if (found != fields_by_dict_.end()) {
      return found->second;
    }
    CPDF_FormControl* control = GetControlByDict(field_dict);
    return control ? control->GetField() : nullptr;
  }
  return field_tree_->GetField(CPDF_FormField::GetFullNameForDict(field_dict));`)
  await replaceOnce(coreSource,
    '  if (!kids) {\n    AddTerminalField(std::move(field_dict));',
    '  if (!kids || (distinct_fields_ && kids->size() == 0)) {\n    AddTerminalField(std::move(field_dict));')
  await replaceOnce(coreSource,
    `  if (!field_dict->KeyExist(pdfium::form_fields::kFT)) {
    // Key "FT" is required for terminal fields, it is also inheritable.`,
    `  if (distinct_fields_) {
    if (!CPDF_FormField::GetFieldAttrForDict(field_dict.Get(),
                                            pdfium::form_fields::kFT)) {
      return;
    }
  } else if (!field_dict->KeyExist(pdfium::form_fields::kFT)) {
    // Key "FT" is required for terminal fields, it is also inheritable.`)
  await replaceOnce(coreSource,
    `  CPDF_FormField* field = field_tree_->GetField(field_name);
  if (!field) {
    RetainPtr<CPDF_Dictionary> pParent(field_dict);
    if (!field_dict->KeyExist(pdfium::form_fields::kT) &&
        field_dict->GetNameFor("Subtype") == "Widget") {
      pParent = field_dict->GetMutableDictFor(pdfium::form_fields::kParent);
      if (!pParent) {
        pParent = field_dict;
      }
    }

    if (pParent && pParent != field_dict &&`,
    `  RetainPtr<CPDF_Dictionary> pParent(field_dict);
  if (!field_dict->KeyExist(pdfium::form_fields::kT) &&
      field_dict->GetNameFor("Subtype") == "Widget") {
    if (auto parent = field_dict->GetMutableDictFor(pdfium::form_fields::kParent)) {
      pParent = std::move(parent);
    }
  }

  CPDF_FormField* field = distinct_fields_
      ? GetFieldByDict(pParent.Get())
      : field_tree_->GetField(field_name);
  if (!field) {
    if (!distinct_fields_ && pParent != field_dict &&`)
  await replaceOnce(coreSource,
    'pdfium::MakeRetain<CPDF_FormField>(this, std::move(pParent));',
    'pdfium::MakeRetain<CPDF_FormField>(this, pParent);')
  await replaceOnce(coreSource,
    '    if (ToReference(t_obj)) {\n      RetainPtr<CPDF_Object> t_obj_clone',
    '    if (!distinct_fields_ && ToReference(t_obj)) {\n      RetainPtr<CPDF_Object> t_obj_clone')
  await replaceOnce(coreSource,
    `    if (!field_tree_->SetField(field_name, std::move(new_field))) {
      return;
    }`,
    `    if (distinct_fields_) {
      fields_by_dict_.emplace(pParent.Get(), field);
      object_fields_.push_back(std::move(new_field));
    } else if (!field_tree_->SetField(field_name, std::move(new_field))) {
      return;
    }`)
  await replaceOnce(sdkHeader,
    '  explicit CPDFSDK_InteractiveForm(CPDFSDK_FormFillEnvironment* pFormFillEnv);',
    `  explicit CPDFSDK_InteractiveForm(CPDFSDK_FormFillEnvironment* pFormFillEnv,
                                   bool distinct_fields = false);`)
  await replaceOnce(sdkSource,
    `    CPDFSDK_FormFillEnvironment* pFormFillEnv)
    : form_fill_env_(pFormFillEnv),
      interactive_form_(std::make_unique<CPDF_InteractiveForm>(
          form_fill_env_->GetPDFDocument())) {`,
    `    CPDFSDK_FormFillEnvironment* pFormFillEnv,
    bool distinct_fields)
    : form_fill_env_(pFormFillEnv),
      interactive_form_(std::make_unique<CPDF_InteractiveForm>(
          form_fill_env_->GetPDFDocument(), distinct_fields)) {`)
  await replaceOnce(envHeader,
    '  CPDFSDK_InteractiveForm* GetInteractiveForm();  // Creates if not present.',
    '  CPDFSDK_InteractiveForm* GetInteractiveForm(bool distinct_fields = false);')
  await replaceOnce(envSource,
    `CPDFSDK_InteractiveForm* CPDFSDK_FormFillEnvironment::GetInteractiveForm() {
  if (!interactive_form_) {
    interactive_form_ = std::make_unique<CPDFSDK_InteractiveForm>(this);`,
    `CPDFSDK_InteractiveForm* CPDFSDK_FormFillEnvironment::GetInteractiveForm(
    bool distinct_fields) {
  if (!interactive_form_) {
    interactive_form_ =
        std::make_unique<CPDFSDK_InteractiveForm>(this, distinct_fields);`)
}
