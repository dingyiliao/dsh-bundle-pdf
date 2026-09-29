"""Regenerate the small synthetic fixtures with pypdf 6.10 and cryptography.

The encrypted object stream comes first, reproducing pdf-lib's early parse
failure. These documents contain only blank pages and a synthetic annotation.
Private pypdf fields are used only to assemble this reproducible test fixture.
"""
from io import BytesIO
from pathlib import Path
from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject,
    NameObject, NumberObject, RectangleObject, TextStringObject,
)


def fixture(password: str) -> bytes:
    writer = PdfWriter()
    page = writer.add_blank_page(400, 600)
    page.cropbox = RectangleObject((20, 30, 340, 530))
    page.rotate(90)
    page[NameObject('/UserUnit')] = NumberObject(2)
    writer.add_blank_page(300, 500)
    annotation = DictionaryObject({
        NameObject('/Type'): NameObject('/Annot'),
        NameObject('/Subtype'): NameObject('/Highlight'),
        NameObject('/Rect'): ArrayObject(map(FloatObject, [40, 440, 140, 460])),
        NameObject('/QuadPoints'): ArrayObject(map(FloatObject, [40, 460, 140, 460, 40, 440, 140, 440])),
        NameObject('/C'): ArrayObject(map(FloatObject, [1, 1, 0])),
        NameObject('/CA'): FloatObject(0.4),
        NameObject('/Contents'): TextStringObject('Fixture annotation'),
        NameObject('/T'): TextStringObject('Fixture author'),
        NameObject('/CreationDate'): TextStringObject('D:20260101000000Z'),
        NameObject('/M'): TextStringObject('D:20260102000000Z'),
    })
    writer.add_annotation(0, annotation)
    writer.add_metadata({'/Title': 'Encrypted compatibility fixture'})
    writer.encrypt(password, 'fixture-owner', algorithm='AES-256')
    encryption_id = writer._encrypt_entry.indirect_reference.idnum
    compressed = [(number, obj) for number, obj in enumerate(writer._objects, 1) if number != encryption_id]
    body = BytesIO()
    header = []
    for number, obj in compressed:
        header.append(f'{number} {body.tell()}')
        obj.write_to_stream(body)
        body.write(b'\n')
    header_bytes = (' '.join(header) + ' ').encode()
    object_stream = DecodedStreamObject()
    object_stream.set_data(header_bytes + body.getvalue())
    object_stream.update({NameObject('/Type'): NameObject('/ObjStm'),
                          NameObject('/N'): NumberObject(len(compressed)),
                          NameObject('/First'): NumberObject(len(header_bytes))})
    object_stream = object_stream.flate_encode()
    stream_id = len(writer._objects) + 1
    xref_id = stream_id + 1
    output = BytesIO()
    output.write(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
    offsets = {}
    for number, obj in [(stream_id, writer._encryption.encrypt_object(object_stream, stream_id, 0)),
                        (encryption_id, writer._encrypt_entry)]:
        offsets[number] = output.tell()
        output.write(f'{number} 0 obj\n'.encode())
        obj.write_to_stream(output)
        output.write(b'\nendobj\n')
    offsets[xref_id] = output.tell()
    indexes = {number: index for index, (number, _) in enumerate(compressed)}
    entries = []
    for number in range(xref_id + 1):
        kind, value, generation = ((0, 0, 65535) if number == 0 else
                                  (2, stream_id, indexes[number]) if number in indexes else
                                  (1, offsets[number], 0))
        entries.append(bytes([kind]) + value.to_bytes(4, 'big') + generation.to_bytes(2, 'big'))
    xref = DecodedStreamObject()
    xref.set_data(b''.join(entries))
    xref.update({NameObject('/Type'): NameObject('/XRef'),
                 NameObject('/Size'): NumberObject(xref_id + 1),
                 NameObject('/W'): ArrayObject(map(NumberObject, [1, 4, 2])),
                 NameObject('/Root'): writer.root_object.indirect_reference,
                 NameObject('/Info'): writer._info.indirect_reference,
                 NameObject('/Encrypt'): writer._encrypt_entry.indirect_reference,
                 NameObject('/ID'): writer._ID})
    output.write(f'{xref_id} 0 obj\n'.encode())
    xref.flate_encode().write_to_stream(output)
    output.write(f'\nendobj\nstartxref\n{offsets[xref_id]}\n%%EOF\n'.encode())
    return output.getvalue()


if __name__ == '__main__':
    directory = Path(__file__).parent
    (directory / 'encrypted-object-stream.pdf').write_bytes(fixture(''))
    (directory / 'password-object-stream.pdf').write_bytes(fixture('fixture-password'))
