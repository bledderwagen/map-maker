"""A small helper for building Geometry Nodes trees from Python without a page of links.new calls"""

import bpy


def _enabled(sockets):
    return [s for s in sockets if s.enabled]


def _socket(sockets, key):
    """A socket by name or by index among the enabled ones. Many nodes have several sockets with
    the same name for different data types, only one of which is enabled"""
    if isinstance(key, int):
        return _enabled(sockets)[key]
    for s in sockets:
        if s.enabled and (s.name == key or s.identifier == key):
            return s
    raise KeyError(key)


class Tree:
    def __init__(self, name, inputs=()):
        """A new Geometry Nodes group with Geometry in and out, plus extra inputs given as
        (name, socket_type, default, min, max, description)"""
        self.group = bpy.data.node_groups.new(name, "GeometryNodeTree")
        self.group.is_modifier = True
        iface = self.group.interface
        iface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
        iface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
        for name_, socket_type, default, lo, hi, description in inputs:
            s = iface.new_socket(name_, in_out="INPUT", socket_type=socket_type)
            s.default_value = default
            if lo is not None:
                s.min_value = lo
            if hi is not None:
                s.max_value = hi
            s.description = description
        self.nodes = self.group.nodes
        self.links = self.group.links
        self.input = self.nodes.new("NodeGroupInput")
        self.output = self.nodes.new("NodeGroupOutput")

    def arg(self, name):
        return _socket(self.input.outputs, name)

    def finish(self, geometry):
        self.link(geometry, _socket(self.output.inputs, "Geometry"))
        self._layout()
        return self.group

    # Building blocks

    def link(self, value, socket):
        if isinstance(value, bpy.types.Node):
            value = _enabled(value.outputs)[0]
        if isinstance(value, bpy.types.NodeSocket):
            self.links.new(value, socket)
        else:
            socket.default_value = value

    def node(self, bl_idname, inputs=None, **props):
        n = self.nodes.new(bl_idname)
        for k, v in props.items():
            setattr(n, k, v)
        for key, value in (inputs or {}).items():
            self.link(value, _socket(n.inputs, key))
        return n

    @staticmethod
    def out(node, key=0):
        return _socket(node.outputs, key)

    def attr(self, name, data_type="FLOAT"):
        return self.out(self.node("GeometryNodeInputNamedAttribute", {"Name": name}, data_type=data_type), "Attribute")

    def math(self, op, a, b=0.0, c=0.0):
        n = self.nodes.new("ShaderNodeMath")
        n.operation = op
        enabled = _enabled(n.inputs)
        for sock, value in zip(enabled, (a, b, c)):
            self.link(value, sock)
        return self.out(n)

    def vec(self, x=0.0, y=0.0, z=0.0):
        return self.out(self.node("ShaderNodeCombineXYZ", {"X": x, "Y": y, "Z": z}))

    def int_eq(self, a, value):
        return self.out(self.node("FunctionNodeCompare", {"A": a, "B": value}, data_type="INT", operation="EQUAL"))

    def bool_op(self, op, a, b=False):
        n = self.nodes.new("FunctionNodeBooleanMath")
        n.operation = op
        for sock, value in zip(_enabled(n.inputs), (a, b)):
            self.link(value, sock)
        return self.out(n)

    def any_of(self, selections):
        """OR of a list of boolean sockets, False if empty"""
        if not selections:
            return False
        result = selections[0]
        for s in selections[1:]:
            result = self.bool_op("OR", result, s)
        return result

    def class_materials(self, geometry, class_materials, attribute="class_id"):
        """Chain of Set Material nodes, one per (class_id, material)"""
        class_id = self.attr(attribute, "INT")
        for cid, material in class_materials:
            geometry = self.out(self.node("GeometryNodeSetMaterial", {
                "Geometry": geometry, "Selection": self.int_eq(class_id, cid), "Material": material}))
        return geometry

    def _layout(self):
        """Columns by longest path from the inputs, so the tree is readable in the editor"""
        depth = {n.name: 0 for n in self.nodes}
        for _ in range(len(self.nodes)):
            changed = False
            for l in self.links:
                d = depth[l.from_node.name] + 1
                if d > depth[l.to_node.name]:
                    depth[l.to_node.name] = d
                    changed = True
            if not changed:
                break
        depth[self.output.name] = max(depth.values()) + 1
        rows = {}
        for n in self.nodes:
            d = depth[n.name]
            row = rows.get(d, 0)
            rows[d] = row + 1
            n.location = (d * 220.0, -row * 190.0)
