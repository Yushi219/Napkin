"""NAPKIN -> Rhino live link (one-way, file-based).

In NAPKIN press "⟳ Live" and pick a folder. The app writes napkin-live.3dm
there on every change. Run this script inside Rhino (drag it into the viewport,
or ScriptEditor > run) and pick the SAME file once — from then on every change
in the browser re-imports automatically. Press Esc to stop watching.

Objects arrive on the layer "NAPKIN building"; each re-import replaces the
previous one, so your own Rhino work on other layers is never touched.
"""
import os
import time

import Rhino
import rhinoscriptsyntax as rs
import scriptcontext as sc

LAYER = "NAPKIN building"


def purge_previous():
    if rs.IsLayer(LAYER):
        rs.DeleteObjects(rs.ObjectsByLayer(LAYER) or [])


def import_file(path):
    purge_previous()
    before = set(rs.AllObjects() or [])
    rs.Command('_-Import "{}" _Enter'.format(path), False)
    added = [o for o in (rs.AllObjects() or []) if o not in before]
    if added:
        if not rs.IsLayer(LAYER):
            rs.AddLayer(LAYER, (189, 95, 61))
        for obj in added:
            rs.ObjectLayer(obj, LAYER)
    rs.Redraw()
    return len(added)


def main():
    path = rs.OpenFileName("Pick napkin-live.3dm (the file NAPKIN's Live-link writes)", "3dm files|*.3dm||")
    if not path:
        return
    print("NAPKIN live link: watching {} — press Esc to stop.".format(os.path.basename(path)))
    last = 0
    while True:
        if sc.escape_test(False):
            print("NAPKIN live link: stopped.")
            break
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = 0
        if mtime > last:
            last = mtime
            time.sleep(0.25)  # let the browser finish writing
            n = import_file(path)
            print("NAPKIN live link: reloaded {} objects at {}".format(n, time.strftime("%H:%M:%S")))
        Rhino.RhinoApp.Wait()
        time.sleep(0.4)


main()
