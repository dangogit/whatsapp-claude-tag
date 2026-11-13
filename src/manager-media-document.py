#!/usr/bin/env python3
"""Bounded DOCX text extraction; never extract ZIP members or follow relationships."""
import json
import sys
import zipfile
import xml.etree.ElementTree as ET

LIMIT = 24576

try:
    with zipfile.ZipFile(sys.argv[1]) as archive:
        members = archive.infolist()
        names = [member.filename for member in members]
        if len(members) > 2000 or len(set(names)) != len(names):
            raise ValueError('archive_limit')
        if sum(member.file_size for member in members) > 32 * 1024 * 1024:
            raise ValueError('archive_limit')
        if any(member.flag_bits & 1 or member.file_size > 8 * 1024 * 1024
               or member.file_size > max(1024 * 1024, member.compress_size * 200)
               or member.filename.startswith('/') or '..' in member.filename.split('/')
               or '\\' in member.filename for member in members):
            raise ValueError('archive_limit')
        if '[Content_Types].xml' not in names or 'word/document.xml' not in names:
            raise ValueError('invalid_content')
        if any('vba' in name.lower() or 'embeddings/' in name.lower()
               or name.lower().endswith(('.exe', '.dll', '.js', '.bin')) for name in names):
            raise ValueError('active_content')
        types = archive.read('[Content_Types].xml')
        if b'macroEnabled' in types or b'vbaProject' in types:
            raise ValueError('active_content')
        xml = archive.read('word/document.xml')
        if b'<!DOCTYPE' in xml.upper() or b'<!ENTITY' in xml.upper():
            raise ValueError('active_content')
        root = ET.fromstring(xml)
        ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
        # Only text nodes count; attributes, fields and external links never run.
        paragraphs = [''.join(t.text or '' for t in p.iter(ns + 't')) for p in root.iter(ns + 'p')]
        text = '\n'.join(paragraphs).strip()
        if len(text.encode('utf-8')) > LIMIT:
            raise ValueError('text_limit')
        if not text:
            raise ValueError('empty_content')
        print(json.dumps({'text': text}, ensure_ascii=False))
except (ValueError, zipfile.BadZipFile, KeyError, ET.ParseError) as error:
    reason = str(error) if str(error) in ('archive_limit', 'active_content', 'text_limit', 'empty_content') else 'invalid_content'
    print(json.dumps({'error': reason}))
    sys.exit(2)
